#!/usr/bin/env python3
"""gen_prompt.py — 从宠物画像生成 AI 视频生成提示词（数据链路 v3 的第 6 个脚本）

用法：
    python pipeline/gen_prompt.py --profile <画像.json> --action <动作名> [--action-desc <动词链>] [--style <皮克斯3D卡通风格|写实风格>]

画像 JSON 用 validate_pet.py --profile 校验后自动补全派生比例（ratio/legRatio）。

翻译规则与 docs/02-特征与提示词.md §2 逐字段表一致：
- 品种 → 「皮克斯3D卡通风格的{品种}」
- 长宽高比例 → 「体长体高比约 {长:高}」（取 ratio 前两段）
- 腿长比 → 「腿长比例约 {比}」
- 体型 → 直接引用离散词
- 补充说明 → 原文直译（去口语化）
- 年龄态 → 成年/幼年/老年体态

三条翻译铁律（docs/02 §2）：
1. 否定词禁用——只写要什么，不写不要什么
2. 动作描述用动词链（→ 分隔连续动作）
3. 幅度词显式——大幅动作需叠加「大幅度、快速」类强动作词
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

NEGATIVE_WORDS = ["不要", "别", "避免", "不能", "禁止", "无", "没有", "不用", "无需"]

STYLE_DEFAULT = "皮克斯3D卡通风格"
AGE_MAP = {"幼年": "幼犬体态", "成年": "成年体态", "老年": "老年体态"}

# 动作名 → 建议动作描述（动词链）。自定义动作必须显式传 --action-desc。
DEFAULT_ACTION_DESC = {
    "idle": "安静待机，偶尔眨眼，尾巴轻摇，呼吸平稳",
    "sleep": "侧卧睡觉，身体随呼吸轻轻起伏，眼睛闭合，安详安静",
    "sniff": "低头四处嗅闻，鼻尖贴近地面，好奇地左右探索",
    "wiggle": "身体兴奋地左右扭动撒娇，尾巴大幅度快速摇摆，眼睛亮晶晶",
    "run": "欢快奔跑，步伐轻快有力，尾巴扬起，表情开心",
    "belly": "翻出肚皮躺下，四肢放松，惬意地晒太阳",
    "poop": "先转圈踩好位置，蹲下，解决完跑开",
    "stretch": "前爪向前伸展→弓背→臀部翘起→张嘴打哈欠→恢复趴卧",
}


def check_negative_words(text: str) -> list[str]:
    """铁律 1：检测否定词（拉粑粑 v5 教训）。"""
    return [w for w in NEGATIVE_WORDS if w in text]


def build_prompt(profile: dict[str, Any], action: str, action_desc: str | None, style: str) -> str:
    """按 docs/02 §2 逐字段翻译规则生成五要素提示词。"""
    breed = profile.get("breed", "")
    ratio = profile.get("ratio", "")  # 如 "1.2:0.4:1"
    leg_ratio = profile.get("legRatio", "")  # 如 "0.6:1"
    build = profile.get("build", "")
    notes = profile.get("notes", "")
    age = profile.get("ageStage", "")

    # ① 形象锚定（P0）
    img_anchor = f"保持 @图片1 这只{style}的{breed}形象不变，全身完整入镜，包含尾巴"

    # ② 体型约束（P0）：长:高（取 ratio 第 1、3 段）+ 腿长比
    body_parts = [f"体长体高比约 {ratio.split(':')[0]}:{ratio.split(':')[2]}" if ratio else ""]
    if leg_ratio:
        body_parts.append(f"腿长比例约 {leg_ratio}")
    if build:
        body_parts.append(f"{build}体型")
    body = "，".join(p for p in body_parts if p)

    # ③ 特征细节（P1）
    detail = notes.strip() if notes else ""

    # ④ 动作描述（P0，动词链）
    if action_desc is None:
        action_desc = DEFAULT_ACTION_DESC.get(action, "")
    action_desc = action_desc.strip()
    if not action_desc:
        raise SystemExit(f"❌ 未知动作 {action!r}：请用 --action-desc 提供动词链描述")

    # ⑤ 画质参数（P1）
    age_part = AGE_MAP.get(age, "") if age else ""
    quality = "，".join(p for p in [age_part, "背景干净纯色", "循环自然"] if p)

    parts = [img_anchor, body, detail, action_desc, quality]
    prompt = "，".join(p for p in parts if p)
    return prompt


def main() -> int:
    ap = argparse.ArgumentParser(description="从宠物画像生成 AI 视频提示词")
    ap.add_argument("--profile", required=True, help="宠物画像 JSON（validate_pet.py 派生后的）")
    ap.add_argument("--action", required=True, help="动作名（idle/sleep/... 或自定义）")
    ap.add_argument("--action-desc", help="动作动词链描述（覆盖内置建议）")
    ap.add_argument("--style", default=STYLE_DEFAULT, help="风格（默认皮克斯3D卡通风格）")
    args = ap.parse_args()

    with open(args.profile, "r", encoding="utf-8") as f:
        profile = json.load(f)

    # 派生字段检查（提示先用 validate_pet.py）
    if not profile.get("ratio"):
        print("⚠️  画像缺少 ratio/legRatio——建议先跑: python pipeline/validate_pet.py --profile <画像.json>",
              file=sys.stderr)

    prompt = build_prompt(profile, args.action, args.action_desc, args.style)

    # 铁律检查
    hits = check_negative_words(prompt)
    if hits:
        print(f"⚠️  检测到否定词 {hits}——铁律 1（否定词禁用，拉粑粑 v5 教训）：只写要什么，不写不要什么",
              file=sys.stderr)

    print("=" * 60)
    print(prompt)
    print("=" * 60)
    print("\n💡 粘贴到即梦/可灵等工具时：@图片1 = 你的设定图；如需动作模仿，追加「模仿 @视频1 的动作」+ 参考视频。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
