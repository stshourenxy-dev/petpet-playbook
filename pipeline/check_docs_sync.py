#!/usr/bin/env python3
"""schema ↔ docs/08 字段漂移检查。

docs/08-接口协议.md 声明「字段表由 schema/pet.schema.json 生成」——
本脚本验证该声明是否属实，防止 schema 与文档再次漂移：

  - 方向一（error）：schema 顶层 properties 或 $defs.action properties 中
    存在 docs/08 §2.1/§2.2 字段表未收录的字段 → 文档落后
  - 方向二（error）：docs/08 字段表出现 schema 中不存在的字段 → schema 落后
    （别名/合并行除外，见 ALLOW_DOC_ONLY）

退出码：任一 error → 1（CI fail）；仅通过 → 0。

用法：python pipeline/check_docs_sync.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "schema" / "pet.schema.json"
DOC = ROOT / "docs" / "08-接口协议.md"

# docs 表格中允许出现、但不在 pet.schema.json 的字段（当前无，保留机制）
ALLOW_DOC_ONLY: set[str] = set()

# 只解析这两个章节的字段表（避开 §2.3 动作名注册表等其它表格）
DOC_SECTIONS = ("2.1 顶层字段", "2.2 动作字段")


def schema_fields():
    s = json.loads(SCHEMA.read_text(encoding="utf-8"))
    top = set(s.get("properties", {}).keys())
    act = set(s["$defs"]["action"].get("properties", {}).keys())
    return top, act


def doc_fields():
    fields = set()
    section = None
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if line.startswith("### "):
            section = line[4:].strip()
            continue
        if section not in DOC_SECTIONS:
            continue
        # 表格行首单元格：| 字段 |  /  | **字段** |  /  | `field` |  /  | a / b |
        m = re.match(
            r"\|\s*\*{0,2}`?([A-Za-z][A-Za-z0-9]*(?:\s*/\s*[A-Za-z][A-Za-z0-9]*)*)`?\*{0,2}\s*\|",
            line,
        )
        if m:
            for part in m.group(1).split("/"):
                fields.add(part.strip())
    return fields


def main():
    top, act = schema_fields()
    doc = doc_fields()
    schema_all = top | act

    missing = sorted(f for f in schema_all if f not in doc)
    doc_only = sorted(f for f in doc if f not in schema_all and f not in ALLOW_DOC_ONLY)

    errors = []
    if missing:
        errors.append(f"docs/08 字段表缺少 schema 已定义的字段: {', '.join(missing)}")
    if doc_only:
        errors.append(f"docs/08 字段表包含 schema 中不存在的字段（schema 落后）: {', '.join(doc_only)}")

    if errors:
        print("❌ schema ↔ docs/08 漂移检查失败：")
        for e in errors:
            print(f"   - {e}")
        print("   修复方式：改 schema 后同步 docs/08；或改 docs 后回填 schema。")
        return 1
    print(f"✅ schema ↔ docs/08 字段一致（顶层 {len(top)} 字段 + 动作 {len(act)} 字段）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
