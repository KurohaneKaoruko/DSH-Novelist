# Novelist · 小说助手（DeepSeek Harness 智能体预设）

一个 DeepSeek Harness 智能体预设，面向中文网络小说的长篇创作。安装后新建会话选择「小说助手」即可使用。

## 包含内容

> skills 本体在独立仓库 [Novelist-Skills](https://github.com/KurohaneKaoruko/Novelist-Skills)（跨项目通用，不绑死本仓库），以 submodule 形式挂载于本仓库 `skills/` 目录：12 个方法论 skill 按需加载，6 个文风 skill 按作品风格加载。各 skill 的清单与职责见 [Novelist-Skills README](https://github.com/KurohaneKaoruko/Novelist-Skills#readme)。克隆本仓库请带 `--recurse-submodules`。

**1 个插件（8 个工具，纯代码实现，无模型调用）**

| 工具 | 用途 |
| --- | --- |
| novel_lint | 正文检查：标点纪律、引号规范、禁用词、副词/极端词频次、对话标签密度、段尾总结句、章末模板收尾、句长均匀度、连续同句式等 25 项规则 |
| novel_check | 名词一致性核对：找出正文反复出现却未建档的高频词 |
| novel_briefing | 写前材料组装：前 10 章结尾、人物卡、伏笔清单、时间线、文风卡 |
| novel_archive | 归档三件套落盘：伏笔清单、时间线、归档记录 |
| novel_project | 工程操作：查询/拉取工程模板、按规范（obsidian/webui）初始化、保存章节（内置质量门禁）、进度统计、整理索引 |
| novel_import | 旧稿分章导入 |
| novel_scan_book | 全书体检材料组装 |
| novel_webui | WebUI 服务管理：安装/启动/停止作品工程的网页管理端，支持单工程与多工程工作区 |

## 工程规范

创建作品工程时先选**工程规范**（`novel_project action=初始化工程 规范=…`）：

| | obsidian（默认） | webui |
| --- | --- | --- |
| 内容数据 | 纯 Markdown | 纯 Markdown（与 obsidian 完全一致） |
| 额外文件 | 无 | `.webui/` 隐藏目录（Obsidian 不显示） |
| 编辑方式 | Obsidian / Agent / 文本编辑器 | 上述全部 + 浏览器网页 |
| 多工程管理 | 逐个打开 | 工作区模式，一个页面集中管理所有作品工程 |

两种规范共享同一批 md 文件（**md 是唯一事实源**），随时互转：obsidian 工程 `novel_webui action=安装服务` 原地升级为 webui；删掉 `.webui/` 即回到纯 obsidian。详见 [webui/README.md](webui/README.md)。

webui 规范的网页管理端（零 npm 依赖，默认只监听 127.0.0.1）提供：人物卡/设定卡管理（新建内置《novel-profiles》格式脚手架）、大纲与剧情线表格编辑、章节阅读与保存（执行与 Agent 相同的质量门禁）、伏笔/时间线表格编辑、AI 味检查（与 novel_lint 同源规则）、全文搜索、旧稿分章、字数统计。

## 工程模板

工程骨架是**数据化的模板**（`templates/` 目录），Agent 初始化工程时按 id 整套拉取，不必从零搭建：

| 模板 | 说明 |
| --- | --- |
| blank | 空白工程：标准骨架 + 全部待填占位（默认） |
| hotblood-xuanhuan | 热血玄幻：金手指/升级链总纲、力量体系等级阶梯、爽点规划表（压转爽钩）、主角人物卡 |
| mystery-suspense | 悬疑诡秘：谜面与真相分离、线索登记表（公平性自查）、规则与禁忌 |
| romance-sweet | 甜宠言情：核心 CP 总纲、感情线节点表（糖点节奏）、双主角人物卡（语言指纹） |

- 查询：`novel_project action=查询模板`；使用：`novel_project action=初始化工程 title=书名 template=hotblood-xuanhuan 规范=webui`
- 模板与规范可任意组合；在作品工程的公共父目录放 `templates/<id>/` 即为工作区自定义模板（优先于内置）。编写规范见 [templates/README.md](templates/README.md)。

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
npm run verify:webui            # WebUI 服务 + 工程模板冒烟（不需要 dsh 内核）
```

CI（`.github/workflows/verify.yml`）在 push 时自动跑同一套验证。`tools/` 是开发工具，不随预设安装。

更新 skills 子模块到上游最新：`git submodule update --remote skills`（改完记得提交 `skills` 指针）。

## 许可证

[MIT License](LICENSE) © 2026 KurohaneKaoruko
