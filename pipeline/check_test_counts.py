#!/usr/bin/env python3
"""check_test_counts.py — 台账测试计数与真实测试数量一致性检查

背景：docs/13-验证台账 §2 的 vitest/pytest 计数反复漂移（45→62、21→24 两次过时），
本脚本在 CI 上实际统计测试数量并与台账比对，漂移即红。

用法：
    python pipeline/check_test_counts.py --side python   # pytest --collect-only 统计（pipeline-test job）
    python pipeline/check_test_counts.py --side js        # vitest --reporter=json 统计（viewer-build job）
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "docs" / "13-验证台账-20260810.md"


def ledger_count(side: str) -> int:
    """从台账 §2 提取预期计数（vitest（viewer）/ pytest（pipeline）行）"""
    text = LEDGER.read_text(encoding="utf-8")
    key = "vitest" if side == "js" else "pytest"
    for line in text.splitlines():
        if key in line and "通过" in line:
            m = re.search(r"✅\s*(\d+)\s*通过", line)
            if m:
                return int(m.group(1))
    raise SystemExit(f"台账中未找到 {key} 计数行")


def actual_python() -> int:
    r = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", str(ROOT / "tests")],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    m = re.search(r"(\d+) tests? collected", r.stdout + r.stderr)
    if not m:
        print(r.stdout[-500:], r.stderr[-500:])
        raise SystemExit("pytest --collect-only 输出无法解析")
    return int(m.group(1))


def actual_js() -> int:
    r = subprocess.run(
        ["npx", "vitest", "run", "--reporter=json"], cwd=ROOT / "viewer",
        capture_output=True, text=True, check=False,
    )
    try:
        data = json.loads(r.stdout[r.stdout.find("{"):])
        return int(data.get("numTotalTests", 0))
    except (json.JSONDecodeError, ValueError, TypeError, KeyError) as e:
        print(r.stdout[-500:], r.stderr[-500:])
        raise SystemExit(f"vitest json 输出无法解析: {e}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--side", required=True, choices=["python", "js"])
    args = ap.parse_args()

    expected = ledger_count(args.side)
    actual = actual_python() if args.side == "python" else actual_js()

    if actual != expected:
        print(f"❌ 测试计数漂移：台账写 {expected}，实际 {actual}（{args.side}）")
        print("   修复方式：更新 docs/13 §2 测试矩阵的计数（真实数量以本次输出为准）")
        return 1
    print(f"✅ 台账计数一致（{args.side}: {actual}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
