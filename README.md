# DSH-Novelist · 小说助手

一个 DeepSeek Harness 智能体预设，面向中文网络小说的长篇创作，可以把小说的设定和正文作为一个作品工程来管理。

安装后新建会话选择「小说助手」即可使用。

建议搭配 Obsidian 或是其他支持 Markdown 文件的笔记软件。

## 包含内容

> skills 本体在独立仓库 [Novelist-Skills](https://github.com/KurohaneKaoruko/Novelist-Skills)，以 submodule 形式挂载于本仓库 `skills/` 目录：12 个方法论 skill 按需加载，6 个文风 skill 按作品风格加载。各 skill 的清单与职责见 [Novelist-Skills README](https://github.com/KurohaneKaoruko/Novelist-Skills#readme)。克隆本仓库请带 `--recurse-submodules`。

**1 个插件（7 个工具，纯代码实现，无模型调用）**

| 工具 | 用途 |
| --- | --- |
| novel_lint | 正文检查：标点纪律、引号/括号配对、半角标点混入、禁用词、副词/极端词频次、迂回定义句式（不是而是/并非/不仅仅是，零容忍）、对话标签密度、段尾总结句、章末模板收尾、句长均匀度、连续同句式、整句重复、段落开头雷同、章节字数区间等 33 项规则 |
| novel_check | 名词一致性核对：找出正文反复出现却未建档的高频词 |
| novel_briefing | 写前材料组装：前 10 章结尾、人物卡、伏笔清单与伏笔体检（悬空章数）、时间线、文风卡 |
| novel_archive | 归档三件套落盘：伏笔清单、时间线、归档记录（格式校验拒收） |
| novel_project | 工程操作：初始化、保存章节（内置质量门禁）、进度统计（含篇幅偏离标记） |
| novel_import | 旧稿分章导入（撞号保护，不静默覆盖现有正文） |
| novel_scan_book | 全书体检材料组装 |

## 安装

把本仓库交给任意 DeepSeek Harness Agent：「请按 INSTALL.md 把 Novelist 安装到当前环境」。手动安装见 [INSTALL.md](INSTALL.md)。

安装方式随 DSH 版本分流（实测分界线）：

| DSH 版本 | 安装方式 |
| --- | --- |
| ≥ 0.1.7（含 0.2.x） | **bundle 安装**（插件管理器 `install_bundle`，目标为本仓库目录）。此区间 `.agent-presets/` 目录式预设已不被读取 |
| ≤ 0.1.6（目录式区间） | **目录复制**到 `~/.dsh/.agent-presets/novelist/` |

- git 克隆请带子模块：`git clone --recurse-submodules <本仓库>`（已克隆的项目补拉：`git submodule update --init`）
- 卸载：≥ 0.1.7 在插件管理器移除 `dsh-novelist` bundle（并删除残留的 `~/.dsh/.agent-presets/novelist`）；≤ 0.1.6 删除该目录即可

## 开发与验证

改完人设 / 工具 / skill 后，先跑规则单测，再用真实 dsh 内核冒烟验证两条安装路线（组合内探针插件直接盘问 roster / 挂载诊断 / scoped skills，不需要 API Key）：

```bash
cd tools
npm test                        # 正文检查引擎单测（规则级回归，秒级，无需内核）
npm run kernel:install          # 目录式验证内核（@deepseek-ai/dsh@0.1.2-rc.1）
npm run verify:kernel           # 目录式路线冒烟（0.1.2，硬断言：roster/挂载/skills）
npm run kernel:install:bundle   # bundle 验证内核（@deepseek-ai/dsh@0.2.0-rc.2）
npm run verify:bundle           # bundle 路线冒烟（≥ 0.1.7，硬断言同上）
npm run verify:acp              # 交互式 ACP 冒烟（目录式）
```

检查引擎住在 `plugins/lint.mjs`（`novel_lint` 与保存门禁共用同一份实现），规则判定由 `tools/test-lint.mjs` 钉住——改规则时同步加用例，并做一次证伪（把规则改坏，确认用例翻红）。

CI（`.github/workflows/verify.yml`）在 push 时自动跑单测与两条安装路线的冒烟验证。`tools/` 是开发工具，不随预设安装。

更新 skills 子模块到上游最新：`git submodule update --remote skills`（改完记得提交 `skills` 指针）。


## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
