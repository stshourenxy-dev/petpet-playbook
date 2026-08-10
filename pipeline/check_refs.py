#!/usr/bin/env python3
"""docs/14 实现状态矩阵引用完整性检查。

验证矩阵中每一项引用都真实存在，防止矩阵本身成为新的漂移源：
  1. 证据列中的反引号代码符号 → 必须在 viewer/ 代码中存在
  2. 证据列中的文件路径 → 必须存在（.ts 相对路径尝试 viewer/src/ 前缀）
  3. 全文引用的 7 位 commit hash → 必须是仓库真实提交

用法：python pipeline/check_refs.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MATRIX = ROOT / "docs" / "14-实现状态矩阵.md"
COMMIT_RE = re.compile(r"\b[0-9a-f]{7}\b")
FILE_RE = re.compile(r"[\w./-]+\.(?:md|ts|cjs|js|py)")
SYM_RE = re.compile(r"`([^`]+)`")


def code_text() -> str:
    """拼接 viewer/ 全部代码文件文本（用于符号 grep）"""
    parts = []
    for p in (ROOT / "viewer").rglob("*"):
        if p.suffix in (".ts", ".cjs", ".js") and "node_modules" not in str(p):
            parts.append(p.read_text(encoding="utf-8", errors="ignore"))
    return "\n".join(parts)


def extract_rows() -> list[list[str]]:
    """提取矩阵数据行（全部单元格）"""
    rows = []
    for line in MATRIX.read_text(encoding="utf-8").splitlines():
        if not line.startswith("|") or line.startswith("|---") or "能力" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        # 仅处理含证据列（第 6 列）的数据行，跳过说明区
        if len(cells) >= 7 and cells[5] and cells[5] != "证据":
            rows.append(cells)
    return rows


def main() -> int:
    code = code_text()
    errors: list[str] = []
    symbols_seen: set[str] = set()

    for cells in extract_rows():
        row_text = " | ".join(cells)
        evidence = cells[5]

        # 1. 反引号符号（整行提取；含 . 取首段；跳过占位符/章节引用）
        for sym in SYM_RE.findall(row_text):
            if "{" in sym or "§" in sym or " " in sym:
                continue
            base = sym.split(".")[0]
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", base):
                continue
            if base in symbols_seen:
                continue
            symbols_seen.add(base)
            if not re.search(rf"\b{re.escape(base)}\b", code):
                errors.append(f"符号不存在: {base}（行: {cells[0][:20]}）")

        # 2. 文件路径（证据列；无前缀的相对路径尝试 viewer/ 与 viewer/src/ 前缀）
        for fp in FILE_RE.findall(evidence):
            cand = ROOT / fp
            if cand.exists():
                continue
            if (ROOT / "viewer" / fp).exists():
                continue
            if fp.endswith(".ts") and (ROOT / "viewer" / "src" / fp).exists():
                continue
            errors.append(f"文件不存在: {fp}（行: {cells[0][:20]}）")

    # 3. commit 存在性（全文引用）
    for c in COMMIT_RE.findall(MATRIX.read_text(encoding="utf-8")):
        r = subprocess.run(
            ["git", "cat-file", "-t", c], cwd=ROOT, capture_output=True, text=True, check=False
        )
        if r.returncode != 0:
            errors.append(f"commit 不存在: {c}")

    if errors:
        print("❌ 矩阵引用检查失败：")
        for e in errors:
            print(f"  - {e}")
        print("   修复方式：改 docs/14 引用的符号/路径/commit，或回填代码。")
        return 1
    print(f"✅ 矩阵引用完整（{len(symbols_seen)} 个符号 + 文件路径 + commit 全部真实）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
