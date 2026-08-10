#!/usr/bin/env python3
"""validate_pet.py — 宠物包 / 宠物画像校验器（数据链路 v3 的第 5 个管线脚本）

用法：
    python pipeline/validate_pet.py <宠物包目录>          # 校验 pet.json + 精灵表存在性 + 纹理上限
    python pipeline/validate_pet.py <pet.json 路径>       # 同上
    python pipeline/validate_pet.py --profile <画像.json> # 校验画像字段 + 自动计算派生比例

设计原则（docs/08-接口协议.md §2）：
- 失败时给出结构化错误（哪个字段、为什么），不静默
- pet.json 顶层 version 2 兼容（旧包），version 3 启用新字段（transitions/bubbles/diary/label）
- 校验规则与 schema/pet.schema.json、schema/pet-profile.schema.json 保持一致
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any

from PIL import Image

PET_ID_RE = re.compile(r"^[a-z0-9_-]+$")
MAX_TEXTURE_WIDTH = 16384  # WebGL 纹理上限（docs/07-踩坑实录.md 铁律 #1）
VALID_THEMES = ("bro", "sis", "orange")
VALID_GENDERS = ("公", "母")
VALID_AGE_STAGES = ("幼年", "成年", "老年")
VALID_DEVICES = ("Windows", "Mac", "双端")
VALID_BUILDS = ("细长", "标准", "粗壮", "胖墩")

# ── 自由文本净化（AI 工具全量审计 V-10：提示注入链 + 间接注入载体）──────
# 剥离：零宽/不可见（U+200B-200F）、BiDi 覆盖（U+202A-202E、U+2066-2069）、
# 字连接/格式（U+2060-206F）、BOM（U+FEFF）、软连字符（U+00AD）、
# 控制字符（C0 除 \n\t、C1）。净化后超长拒绝（maxLength 防存储/渲染滥用）。
_INVISIBLE_RE = re.compile(
    r"[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u00ad"
    r"\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]"
)
TEXT_MAX = {"name": 50, "bubble": 100, "label": 30, "diary": 200, "species": 50, "attr": 50, "habit_key": 30}


def clean_text(s: str) -> str:
    """剥离不可见/控制字符；仅保留可见文本（\n\t 保留）。"""
    return _INVISIBLE_RE.sub("", s)


def check_text(
    data: dict[str, Any],
    field: str,
    key: str,
    max_len: int,
    errors: int,
) -> int:
    """自由文本字段检查：剥离不可见字符后，非空 + 长度上限。返回错误数。"""
    v = data.get(key)
    if not isinstance(v, str):
        errors += 1
        err(f"{field} 应为字符串，实际 {v!r}")
        return errors
    cleaned = clean_text(v)
    if not cleaned.strip():
        errors += 1
        err(f"{field} 剥离不可见字符后为空（可能含零宽/控制字符注入）")
    elif len(cleaned) > max_len:
        errors += 1
        err(f"{field} 超长（≤{max_len} 字符），实际 {len(cleaned)}——防止存储/渲染滥用")
    return errors


def err(msg: str) -> None:
    print(f"  ❌ {msg}")


def ok(msg: str) -> None:
    print(f"  ✅ {msg}")


def warn(msg: str) -> None:
    print(f"  ⚠️  {msg}")


# ============ 宠物包（pet.json）校验 ============

def validate_pet_json(data: dict[str, Any], base_dir: str) -> int:
    """校验 pet.json 结构 + 精灵表存在性 + 纹理上限。返回错误数。"""
    errors = 0
    version = data.get("version")

    if version not in (2, 3):
        errors += 1
        err(f"version 应为 2 或 3，实际 {version!r}（3 为当前契约，2 为兼容旧包）")

    if not isinstance(data.get("id"), str) or not PET_ID_RE.match(data["id"]):
        errors += 1
        err(f"id 必须匹配 {PET_ID_RE.pattern}（= 目录名），实际 {data.get('id')!r}")

    if not isinstance(data.get("name"), str) or not data["name"].strip():
        errors += 1
        err(f"name 必填（显示名），实际 {data.get('name')!r}")
    else:
        errors = check_text(data, "name", "name", TEXT_MAX["name"], errors)

    if "theme" in data and data["theme"] not in VALID_THEMES:
        errors += 1
        err(f"theme 应为 {VALID_THEMES} 之一，实际 {data['theme']!r}")

    if "bubbles" in data and (
        not isinstance(data["bubbles"], list)
        or not all(isinstance(b, str) and b.strip() for b in data["bubbles"])
    ):
        errors += 1
        err("bubbles 应为非空字符串数组（气泡文案池）")
    elif isinstance(data.get("bubbles"), list):
        for i, b in enumerate(data["bubbles"]):
            # 逐条净化校验（不修改原数据——校验器只报错不写回）
            cleaned = clean_text(b)
            if not cleaned.strip():
                errors += 1
                err(f"bubbles[{i}] 剥离不可见字符后为空")
            elif len(cleaned) > TEXT_MAX["bubble"]:
                errors += 1
                err(f"bubbles[{i}] 超长（≤{TEXT_MAX['bubble']} 字符），实际 {len(cleaned)}")

    # V2-A: identity/temperament 校验（2026-08-09，可选字段，缺省=中性）
    if "identity" in data:
        ident = data["identity"]
        if not isinstance(ident, dict):
            errors += 1
            err("identity 应为对象（species/appearance/habits）")
        else:
            if "species" in ident and (not isinstance(ident["species"], str) or not ident["species"].strip()):
                errors += 1
                err("identity.species 应为非空字符串")
            elif isinstance(ident.get("species"), str):
                errors = check_text(ident, "identity.species", "species", TEXT_MAX["species"], errors)
            if "appearance" in ident and not isinstance(ident["appearance"], dict):
                errors += 1
                err("identity.appearance 应为对象")
            elif isinstance(ident.get("appearance"), dict):
                for k, v in ident["appearance"].items():
                    if isinstance(v, str):
                        errors = check_text(ident["appearance"], f"identity.appearance.{k}", k, TEXT_MAX["attr"], errors)
            if "habits" in ident and (
                not isinstance(ident["habits"], dict)
                or not all(isinstance(v, bool) for v in ident["habits"].values())
            ):
                errors += 1
                err("identity.habits 应为布尔值对象（如 {likes_ball: true}）")
            elif isinstance(ident.get("habits"), dict):
                for k in ident["habits"]:
                    errors = check_text(ident["habits"], f"identity.habits.{k}", k, TEXT_MAX["habit_key"], errors)

    if "temperament" in data:
        temp = data["temperament"]
        if not isinstance(temp, dict):
            errors += 1
            err("temperament 应为对象（activity/clinginess/curiosity/independence）")
        else:
            for key in ("activity", "clinginess", "curiosity", "independence"):
                if key in temp:
                    v = temp[key]
                    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (0 <= v <= 1):
                        errors += 1
                        err(f"temperament.{key} 应为 0-1 数值，实际 {v!r}")

    actions = data.get("actions")
    if not isinstance(actions, dict) or not actions:
        errors += 1
        err("actions 必填且至少一个动作")
        return errors

    for name, act in actions.items():
        if not PET_ID_RE.match(name):
            errors += 1
            err(f"动作名 {name!r} 必须匹配 {PET_ID_RE.pattern}")
        if not isinstance(act, dict):
            errors += 1
            err(f"动作 {name} 应为对象")
            continue

        rel = act.get("file") or act.get("sprite")
        if not rel:
            errors += 1
            err(f"动作 {name}: 缺少 file/sprite（精灵表路径）")
        elif not isinstance(rel, str):
            errors += 1
            err(f"动作 {name}: file/sprite 应为字符串")

        for field in ("frames", "frameWidth", "frameHeight"):
            v = act.get(field)
            if not isinstance(v, (int, float)) or v <= 0:
                errors += 1
                err(f"动作 {name}: {field} 必填且为正数，实际 {v!r}")

        for field in ("fps", "weight", "scale"):
            if field in act and (not isinstance(act[field], (int, float)) or act[field] < 0):
                errors += 1
                err(f"动作 {name}: {field} 应为非负数，实际 {act[field]!r}")

        if "loop" in act and not isinstance(act["loop"], bool):
            errors += 1
            err(f"动作 {name}: loop 应为布尔值")

        if "pingpong" in act and not isinstance(act["pingpong"], bool):
            errors += 1
            err(f"动作 {name}: pingpong 应为布尔值")

        # v3 转移链（11-同类项目借鉴 §2.1）
        if "transitions" in act:
            if not isinstance(act["transitions"], dict) or not act["transitions"]:
                errors += 1
                err(f"动作 {name}: transitions 应为非空对象（目标动作→权重）")
            else:
                for target, w in act["transitions"].items():
                    if not PET_ID_RE.match(target):
                        errors += 1
                        err(f"动作 {name}: transitions 目标 {target!r} 非法")
                    if not isinstance(w, (int, float)) or w < 0:
                        errors += 1
                        err(f"动作 {name}: transitions[{target}] 权重应为非负数")

        # v3 文案下沉
        if "label" in act and (not isinstance(act["label"], str) or not act["label"].strip()):
            errors += 1
            err(f"动作 {name}: label 应为非空字符串")
        elif isinstance(act.get("label"), str):
            errors = check_text(act, f"动作 {name}.label", "label", TEXT_MAX["label"], errors)
        if "diary" in act:
            d = act["diary"]
            if not isinstance(d, dict) or not isinstance(d.get("mood"), str) or not isinstance(
                d.get("text"), str
            ):
                errors += 1
                err(f"动作 {name}: diary 应含 mood（字符串）和 text（字符串）")
            else:
                if isinstance(d.get("mood"), str):
                    errors = check_text(d, f"动作 {name}.diary.mood", "mood", TEXT_MAX["label"], errors)
                if isinstance(d.get("text"), str):
                    errors = check_text(d, f"动作 {name}.diary.text", "text", TEXT_MAX["diary"], errors)

        # 精灵表存在性 + 纹理上限（铁律：帧数 × cellWidth ≤ 16384）
        if rel and isinstance(rel, str):
            full = os.path.normpath(os.path.join(base_dir, rel))
            # 配置层面：frames × frameWidth 超限会黑屏（docs/07 铁律 #1）
            fw = act.get("frameWidth")
            fr = act.get("frames")
            if isinstance(fw, (int, float)) and isinstance(fr, (int, float)):
                need = int(fw) * int(fr)
                if need > MAX_TEXTURE_WIDTH:
                    errors += 1
                    err(
                        f"动作 {name}: 配置帧宽×帧数 = {need}px 超过 WebGL 上限 "
                        f"{MAX_TEXTURE_WIDTH}px（24帧×1024 黑屏教训，见 docs/07）"
                    )
            if not os.path.isfile(full):
                errors += 1
                err(f"动作 {name}: 精灵表不存在 {rel}")
            else:
                try:
                    with Image.open(full) as im:
                        w, h = im.size
                    if w > MAX_TEXTURE_WIDTH:
                        errors += 1
                        err(
                            f"动作 {name}: 精灵表实际宽 {w}px 超过 WebGL 上限 "
                            f"{MAX_TEXTURE_WIDTH}px"
                        )
                    # 配置与实际一致：切片需求宽度 ≤ 文件宽度（防切片越界）
                    if isinstance(fw, (int, float)) and isinstance(fr, (int, float)):
                        need = int(fw) * int(fr)
                        if need > w:
                            errors += 1
                            err(
                                f"动作 {name}: 配置需要 {need}px 宽，文件实际 {w}px——"
                                f"后 {int(fr) - w // int(fw)} 帧会切片越界"
                            )
                    ok(f"动作 {name}: 精灵表 {rel}（{w}×{h}）纹理合规")
                except OSError as e:
                    errors += 1
                    err(f"动作 {name}: 精灵表读取失败 {rel}: {e}")

    return errors


# ============ 宠物画像（pet-profile.json）校验 ============

def derive_ratios(data: dict[str, Any]) -> tuple[str | None, str | None]:
    """按 docs/01-数据模型.md §3.3 计算派生比例。返回 (长宽高比例, 腿长比)。"""
    try:
        length, width, height, leg = (
            float(data["lengthCm"]),
            float(data["widthCm"]),
            float(data["heightCm"]),
            float(data["legCm"]),
        )
        if height <= 0:
            return None, None
        # 1 位小数，与 docs/01 §3.3 实例口径一致（红苕 1.2:0.4:1 / 0.6:1）
        def fmt(v: float) -> str:
            s = f"{v:.1f}"
            return s.rstrip("0").rstrip(".") if "." in s else s

        return (
            f"{fmt(length / height)}:{fmt(width / height)}:1",
            f"{fmt(leg / height)}:1",
        )
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None, None


def validate_profile(data: dict[str, Any]) -> int:
    """校验画像层 16 字段（docs/01 §3.2）+ 自动计算派生比例。返回错误数。"""
    errors = 0

    for field in ("owner", "name", "breed"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            errors += 1
            err(f"画像: {field} 必填（非空字符串）")

    if "name" in data and not PET_ID_RE.match(str(data["name"])):
        errors += 1
        err(f"画像: name 必须匹配 {PET_ID_RE.pattern}（= 宠物包目录名）")

    if "gender" in data and data["gender"] not in VALID_GENDERS:
        errors += 1
        err(f"画像: gender 应为 {VALID_GENDERS} 之一，实际 {data.get('gender')!r}")

    if "ageStage" in data and data["ageStage"] not in VALID_AGE_STAGES:
        errors += 1
        err(f"画像: ageStage 应为 {VALID_AGE_STAGES} 之一，实际 {data.get('ageStage')!r}")

    if "devices" in data and data["devices"] not in VALID_DEVICES:
        errors += 1
        err(f"画像: devices 应为 {VALID_DEVICES} 之一，实际 {data.get('devices')!r}")

    if "build" in data and data["build"] not in VALID_BUILDS:
        errors += 1
        err(f"画像: build 应为 {VALID_BUILDS} 之一，实际 {data.get('build')!r}")

    for field in ("lengthCm", "heightCm", "legCm", "widthCm"):
        v = data.get(field)
        if not isinstance(v, (int, float)) or v <= 0:
            errors += 1
            err(f"画像: {field} 必填且为正数（cm），实际 {v!r}")

    if not isinstance(data.get("notes"), str) or not data["notes"].strip():
        errors += 1
        err("画像: notes 必填（花色/特征补充说明，直接进提示词）")

    # 派生字段自动计算（主人不填，机器算）
    ratio, leg_ratio = derive_ratios(data)
    if ratio:
        data["ratio"] = ratio
        data["legRatio"] = leg_ratio
        ok(f"派生比例: 长宽高 {ratio} / 腿长比 {leg_ratio}")
    else:
        errors += 1
        err("画像: 无法计算派生比例（lengthCm/widthCm/heightCm/legCm 需为正数）")

    return errors


# ============ 入口 ============

def load_json(path: str) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    ap = argparse.ArgumentParser(description="宠物包/宠物画像校验器")
    ap.add_argument("path", nargs="?", help="宠物包目录或 pet.json 路径")
    ap.add_argument("--profile", metavar="FILE", help="校验宠物画像 JSON（并自动补派生比例）")
    args = ap.parse_args()

    if args.profile:
        print(f"校验画像: {args.profile}")
        data = load_json(args.profile)
        n = validate_profile(data)
        out = os.path.splitext(args.profile)[0] + ".derived.json"
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        ok(f"派生结果已写入 {out}（供 gen_prompt.py 使用）")
    else:
        if not args.path:
            ap.error("需要提供宠物包路径（目录或 pet.json），或 --profile 画像文件")
        p = args.path
        if os.path.isdir(p):
            p = os.path.join(p, "pet.json")
        if not os.path.isfile(p):
            ap.error(f"找不到 pet.json: {p}")
        print(f"校验宠物包: {p}")
        data = load_json(p)
        n = validate_pet_json(data, os.path.dirname(p))

    if n == 0:
        print("✅ 全部通过")
        return 0
    print(f"\n❌ 共 {n} 处错误")
    return 1


if __name__ == "__main__":
    sys.exit(main())
