# Novelist · 小说助手（DeepSeek Harness 智能体预设）

> 一个 DeepSeek Harness Agent 预设：**7 个方法论 skill + 7 个零模型调用工具**，面向中文网络小说的长篇创作。把本仓库交给任意 DSH Agent，按 INSTALL.md 执行即可完成安装——装完即用，无插件、无浏览器授权步骤。

## 核心理念

**一切正文由 Agent 亲写，工具零模型调用。** 7 个工具全部是纯代码（确定性检查、文件读写、材料组装），不含任何 LLM 子调用；模型生成的质量与过程完全可见、可干预。

## 7 个方法论 skill（按需加载）

| skill | 何时加载 |
| --- | --- |
| `novel-prose-standards` | 写/改/润色/翻译/去AI味任何正文——正文铁律 + 直出即净生成时干预 + 各任务流程 |
| `novel-ai-lexicon` | AI 高频词分级词库（约 200 条）：一级套路模板出现即改写、二级高频滥用限频、句式模板、白名单防误伤 |
| `novel-continuity` | 写前必查清单、前文衔接三锚点、归档回填、剧情漏洞排查 |
| `novel-plotting` | 总纲/卷纲/细纲/章节规划/情节推演/灵感/书名简介包装，含标准细纲模板与节奏量化标准 |
| `novel-craft` | 场景三拍、对话技法、打脸四拍、情绪曲线、角色设计与采访 |
| `novel-analysis` | 小说分析/拆书/评阅（六维评分）/模拟读者团/合规体检/起名 |
| `novel-project` | 工程目录约定、人物卡/设定集/文风卡建档模板、归档三件套格式、Obsidian 工作流 |

## 7 个工具（零模型调用）

| 工具 | 职责 |
| --- | --- |
| `novel_lint` | AI 味确定性检查：标点纪律、引号规范、禁用词、副词/极端词频次、句长均匀度、连续同句式、论文腔等 20 项规则，纯代码秒回 |
| `novel_check` | 名词一致性核对：从工程自动构建名词档案，找出正文里反复出现却未建档的高频词 |
| `novel_briefing` | 写前材料组装：前 10 章结尾（可扩 20 章）、上一章结尾、最近归档、出场人物卡、伏笔清单、时间线、文风卡 |
| `novel_archive` | 归档三件套落盘：伏笔清单覆盖、时间线追加、归档记录写入；表格式不合格直接拒收 |
| `novel_project` | 工程文件操作：初始化目录、保存章节（内置质量门禁）、统计进度、整理双链索引 |
| `novel_import` | 旧稿分章导入：按「第X章」标记自动拆分落盘 |
| `novel_scan_book` | 体检材料组装：抽样选章，汇总工程材料 |

## 安装

把本仓库交给任意 DeepSeek Harness Agent：「请按 INSTALL.md 把 Novelist 安装到当前环境」——自动完成复制与挂载校验。手动安装见 INSTALL.md。

- 预设根目录：`~/.dsh/.agent-presets/novelist`
- 卸载：删除该目录即可

## 姊妹项目

- [DSH-Novel-App](https://github.com/KurohaneKaoruko/DSH-Novel-App)——基于 DSH 的小说写作桌面端（Rust + Tauri，内置本预设的七位风格变体）

## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
