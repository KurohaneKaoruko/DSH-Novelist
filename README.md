# Novelist · 小说助手（DeepSeek Harness 智能体预设）

一个 DeepSeek Harness 智能体预设，面向中文网络小说的长篇创作。安装后新建会话选择「小说助手」即可使用。

## 包含内容

> 13 个 skill 的本体在独立仓库 [Novelist-Skills](https://github.com/KurohaneKaoruko/Novelist-Skills)（跨项目通用，不绑死本仓库），以 submodule 形式挂载于本仓库 `skills/` 目录。克隆本仓库请带 `--recurse-submodules`。

**13 个 skill（按需加载）**

| skill | 用途 |
| --- | --- |
| novel-prose-standards | 正文铁律、直出即净生成时干预、润色/改写/翻译流程 |
| novel-ai-lexicon | AI 味分级特征库：约 260 条词库与句式，含第二代 AI 特征（伪外化、数字装具体、对话标签、段尾总结等结构层）与防误伤白名单 |
| novel-continuity | 写前必查清单、前文衔接三锚点、归档回填、剧情漏洞排查 |
| novel-plotting | 总纲/卷纲/细纲/章节规划/情节推演/书名简介包装 |
| novel-craft | 场景三拍、对话技法、打脸四拍、情绪曲线、角色设计与采访 |
| novel-analysis | 分析/拆书/评阅（六维评分）/模拟读者团/合规体检/起名 |
| novel-project | 工程目录约定、人物卡/设定集/文风卡模板、归档三件套、Obsidian 工作流 |

**6 个风格 skill（按作品风格加载，写什么风格就加载哪个）**

| skill | 用途 |
| --- | --- |
| novel-style-hotblood | 男频热血爽文：爽点密度与升级链、期待感管理、打脸写法、金手指规则、节奏铁律 |
| novel-style-romance | 女频甜宠言情：心动写法、糖点节奏、双视角与信息差、误会分寸、情话对话、日常质感 |
| novel-style-mystery | 悬疑/诡秘/克苏鲁风：谜面先行、线索公平性、恐怖写法、规矩与代价、多层反转、张力控制 |
| novel-style-xianxia | 古风仙侠/武侠：古风语感、体系自洽、打斗意境、江湖质感、山川风物、称谓礼制 |
| novel-style-scifi | 科幻/末世：设定推演、细节颗粒度、末世压力、人性抉择、科学克制、冷静叙述腔 |
| novel-style-lightnovel | 轻小说/二次元风：轻快语感、角色声线、萌点写法、梗的分寸、日常主线配比 |

**1 个插件（7 个工具，纯代码实现，无模型调用）**

| 工具 | 用途 |
| --- | --- |
| novel_lint | 正文检查：标点纪律、引号规范、禁用词、副词/极端词频次、对话标签密度、段尾总结句、章末模板收尾、句长均匀度、连续同句式等 25 项规则 |
| novel_check | 名词一致性核对：找出正文反复出现却未建档的高频词 |
| novel_briefing | 写前材料组装：前 10 章结尾、人物卡、伏笔清单、时间线、文风卡 |
| novel_archive | 归档三件套落盘：伏笔清单、时间线、归档记录 |
| novel_project | 工程操作：初始化、保存章节（内置质量门禁）、进度统计 |
| novel_import | 旧稿分章导入 |
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

改完人设 / 工具 / skill 后，可用 `tools/` 里的工具链以真实 dsh 内核冒烟验证两条安装路线（组合内探针插件直接盘问 roster / 挂载诊断 / scoped skills，不需要 API Key）：

```bash
cd tools
npm run kernel:install          # 目录式验证内核（@deepseek-ai/dsh@0.1.2-rc.1）
npm run verify:kernel           # 目录式路线冒烟（0.1.2，硬断言：roster/挂载/skills）
npm run kernel:install:bundle   # bundle 验证内核（@deepseek-ai/dsh@0.2.0-rc.2）
npm run verify:bundle           # bundle 路线冒烟（≥ 0.1.7，硬断言同上）
npm run verify:acp              # 交互式 ACP 冒烟（目录式）
```

CI（`.github/workflows/verify.yml`）在 push 时自动跑同一套验证。`tools/` 是开发工具，不随预设安装。

更新 skills 子模块到上游最新：`git submodule update --remote skills`（改完记得提交 `skills` 指针）。

## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
