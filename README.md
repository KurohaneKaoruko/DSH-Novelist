# Novelist · 小说助手（DeepSeek Harness 智能体预设）

一个 DeepSeek Harness 智能体预设，面向中文网络小说的长篇创作。安装后新建会话选择「小说助手」即可使用。

## 包含内容

**7 个 skill（方法论，按需加载）**

| skill | 用途 |
| --- | --- |
| novel-prose-standards | 正文铁律、直出即净生成时干预、润色/改写/翻译流程 |
| novel-ai-lexicon | AI 高频词分级词库（约 200 条）与句式模板 |
| novel-continuity | 写前必查清单、前文衔接三锚点、归档回填、剧情漏洞排查 |
| novel-plotting | 总纲/卷纲/细纲/章节规划/情节推演/书名简介包装 |
| novel-craft | 场景三拍、对话技法、打脸四拍、情绪曲线、角色设计与采访 |
| novel-analysis | 分析/拆书/评阅（六维评分）/模拟读者团/合规体检/起名 |
| novel-project | 工程目录约定、人物卡/设定集/文风卡模板、归档三件套、Obsidian 工作流 |

**1 个插件（7 个工具，纯代码实现，无模型调用）**

| 工具 | 用途 |
| --- | --- |
| novel_lint | 正文检查：标点纪律、引号规范、禁用词、副词/极端词频次、句长均匀度、连续同句式等 20 项规则 |
| novel_check | 名词一致性核对：找出正文反复出现却未建档的高频词 |
| novel_briefing | 写前材料组装：前 10 章结尾、人物卡、伏笔清单、时间线、文风卡 |
| novel_archive | 归档三件套落盘：伏笔清单、时间线、归档记录 |
| novel_project | 工程操作：初始化、保存章节（内置质量门禁）、进度统计 |
| novel_import | 旧稿分章导入 |
| novel_scan_book | 全书体检材料组装 |

## 安装

把本仓库交给任意 DeepSeek Harness Agent：「请按 INSTALL.md 把 Novelist 安装到当前环境」。手动安装见 [INSTALL.md](INSTALL.md)。

- 预设安装位置：`~/.dsh/.agent-presets/novelist`
- 卸载：删除该目录即可

## 姊妹项目

[DSH-Novel-App](https://github.com/KurohaneKaoruko/DSH-Novel-App)——基于 DSH 的小说写作桌面端（Rust + Tauri），内置本预设与六种风格变体。

## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
