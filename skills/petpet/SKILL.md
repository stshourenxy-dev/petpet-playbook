# PetPet Playbook — AI 助手工作指南

> 让各类 AI 编程助手能正确地为 PetPet Playbook 项目工作：
> 读契约、跑管线、排查问题。受众 = 正在用本仓库做宠物桌宠的人 + 他们的 AI 助手。

## 项目是什么

不是桌宠软件，是**「从真实宠物照片到桌宠」的方法论 + 工具链 + 参考实现**：
- `docs/`：方法论文档（00-12，中文）
- `pipeline/`：素材管线脚本（Python，6 个）
- `schema/`：机器可读契约（pet.json v3 + 宠物画像 16 字段）
- `viewer/`：客户端参考实现（Electron + PixiJS）
- `examples/redshao-demo/`：可直接运行的最小宠物包

核心思想：**宠物即数据包**——换宠物 = 换目录，不动代码。

## 常用命令

```bash
# 素材管线（按顺序）
python pipeline/select_frames.py --input <抽帧目录> --output selected/ --frames 12
python pipeline/remove_bg.py     --input selected/ --output cutout/
python pipeline/clean_cutout.py  --input cutout/   --output clean/
python pipeline/make_sheet.py    --input clean/    --output . --name mypet.png

# 校验宠物包（打包前必跑）
python pipeline/validate_pet.py <宠物包目录>

# 画像 → 提示词
python pipeline/validate_pet.py --profile pet-profile.json
python pipeline/gen_prompt.py --profile pet-profile.derived.json --action stretch

# 测试
python tests/smoke_test.py
pytest tests/
ruff check pipeline/ tests/

# 客户端
cd viewer && npm install && npm run dev    # 开发
cd viewer && npm run build && npm start    # 构建后启动
```

## 关键契约（先读 docs/08，别猜）

- pet.json 顶层：`version`（当前 3）/ `id` / `name` / `cellWidth` / `cellHeight` / `actions`
- 动作字段：`file|sprite` 二选一、`frames` 必填、`fps` 默认 4、`weight` 默认 0（= 不参与随机）、`transitions`（行为转移链）、`label`（菜单显示名）、`diary`（动作→心情文案）
- 标准 8 动作注册表：`idle/sleep/sniff/wiggle/run/belly/poop/stretch`
- 精灵表契约：**总宽 ≤ 16384px**（WebGL 硬上限，超了黑屏）、PNG 或 WebP 无损、透明底
- activity.json：动作切换时追加（同动作不重复、idle 不记、滚动上限 100 条）

> **提交信息中性**：提交信息、注释和审计记录不得包含具体 AI 工具、厂商或模型名称，一律用「AI 工具」「AI 助手」等通用表述。

## 排查清单（高频事故，详见 docs/07）

| 现象 | 根因 | 修法 |
|------|------|------|
| 黑屏 | 精灵表总宽 > 16384px（如 24 帧×1024 = 24576） | 减帧数或减小 cell |
| 白毛腿半透明/消失 | 背景色抠图对白毛无效 | 用 rembg 语义分割 |
| 腿/尾巴被砍 | 连通域删除把分离肢体当噪点 | 只删 <500px 微小噪点，保留所有连通域 |
| 改资源不生效 | 无热重载，启动时一次性加载 | 改完必须重启应用 |
| 横版帧变小/变形 | 正方形窗口适配 16:9 | 检查 frameWidth/Height 与 cellWidth/Height |

## 工作流（推荐顺序）

1. **先读**：`docs/01`（数据模型）→ `docs/02`（提示词）→ `docs/08`（契约）——三篇定上下文
2. **做素材**：按 `docs/05` 管线走，每步工具可替换
3. **验证**：`validate_pet.py` 必跑 + 真机截图确认（透明区截图显示黑 ≠ 真黑，看画面内容）
4. **发布**：
   - UI/UX 或客户端逻辑变更 → 过 `docs/审查清单.md`（身份假设/错误路径/迭代残留/边界量纲/可访问性/文档一致性六维）
   - 打包 / 发布 / 安全相关变更 → 过 `docs/安全与发布检查清单.md`（路径/压缩包导入、资源炸弹预算、Electron 加固、依赖支持线、CI、tag=package=安装包一致性）
   - 执行后更新对应清单表头「最近执行」（日期 / 执行人 / 基线 commit）

## 边界（诚实标注）

- 双端已真机验证：macOS 日常使用；Windows 经红苕爸爸 Win11 实测（2026-08-09，能装能跑无崩溃，见 docs/09）——发布时如实标注已验证平台
- AI 生成是抽卡：同提示词可能出不同结果，主人核实不可替代
- 即梦生成素材版权归用户，开源发布保留平台 AI 标识
