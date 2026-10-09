# 安装指引

本文件描述如何把 Novelist（小说助手）安装到 DeepSeek Harness。Agent 请按顺序执行；手动安装按同样步骤操作。

## 0. 环境确认（版本分流）

先确认 DSH 版本（`dsh --version`，或桌面端「关于」页）：

| DSH 版本 | 走哪条路线 | 原因（实测） |
| --- | --- | --- |
| **≥ 0.1.7**（含 0.1.7-rc、0.2.x） | **路线 A：bundle 安装** | 此区间 `.agent-presets/` 目录式预设已不被任何机制读取；预设改为「随 bundle 补丁分发的 `@deepseek-ai/dsh-agent-preset` 声明」 |
| **≤ 0.1.6**（0.1.2 ~ 0.1.6） | **路线 B：目录复制** | 该区间预设仍从 `$DSH_HOME/.agent-presets/<id>/` 读取；声明式 bundle 机制尚不存在 |

判断不了版本时优先尝试路线 A：`dsh plugin` 子命令或桌面端「插件管理器」存在即支持 bundle。

---

## 路线 A：bundle 安装（DSH ≥ 0.1.7）

本仓库是一个标准 DSH bundle：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，其中用 `@deepseek-ai/dsh-agent-preset` 声明完整预设（persona、工具行、`skills/` 与 `plugins/novel-tools.mjs` 随包分发）。

1. git 克隆本仓库（带子模块）：`git clone --recurse-submodules https://github.com/KurohaneKaoruko/DSH-Novelist.git`；已克隆的项目补拉 `git submodule update --init`。记下仓库绝对路径（下称 `<仓库目录>`）。
2. 安装（任选其一）：
   - **桌面端**：插件管理器 → 安装 bundle → 目标填 `<仓库目录>`；
   - **Agent**：调用 `plugin_manager` 工具，`action: install_bundle`，`target: <仓库目录>`；
   - **CLI**：`dsh plugin --profile <profile名> add <仓库目录>`（工具会自己完成包安装与 bundle 选择，不要手工改 profile 的 package.json 复刻这些步骤）。
3. 挂载校验：`plugin_manager` 的 `list_bundles` 应列出 `dsh-novelist`；`list_plugins` 应有 `preset-novelist` 行且无激活诊断。roster（预设选择器）应出现「**小说助手**」。
4. 新建会话选择「小说助手」，确认：
   - 工具列表包含 `novel_lint` / `novel_check` / `novel_briefing` / `novel_archive` / `novel_project` / `novel_import` / `novel_scan_book` / `novel_webui`；
   - 技能列表包含 13 个 `novel-*` skill（7 个方法论 + 6 个 novel-style-* 风格，风格按作品归属加载）；
   - 系统提示包含「小说助手」人设与工作法路由段。

**从旧目录式安装迁移**：若之前把本仓库复制到了 `$DSH_HOME/.agent-presets/novelist/`，该目录在 ≥ 0.1.7 上不被读取也不会报错。按本路线安装 bundle 并验证后，删除该遗留目录即可（DSH 官方技能 *Migrate a legacy preset* 同此建议）。

## 路线 B：目录复制（DSH ≤ 0.1.6）

1. 把仓库根目录的全部内容（`preset.yml`、`agent.cordis.yml`、`plugins/`、`skills/`、`templates/`、`webui/` 六样）复制到 `$HOME/.dsh/.agent-presets/novelist/`（Windows 即 `C:\Users\<用户名>\.dsh\.agent-presets\novelist\`；可用 `echo $env:DSH_HOME` 确认根目录）。
   - 本仓库以 submodule 引用 `skills/`（独立仓库 Novelist-Skills）：git 克隆请带 `--recurse-submodules`，否则 `skills/` 为空目录。
   - `templates/`（工程模板）与 `webui/`（WebUI 服务资产）必须随行：插件初始化 webui 规范工程、拉取工程模板时从安装位读取它们；缺失时工程初始化会回退到内置骨架，但模板与 WebUI 功能不可用。
   - 该目录在会话工作区之外：若文件写入被沙箱拒绝，用 sandbox_permissions 重试一次（需用户批准）。
2. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过。
3. 收尾同路线 A 第 4 步（预设选择器选「小说助手」并核对工具/技能/人设）。

> 兼容性说明：`agent.cordis.yml` 的 persona 行同时携带 `prefix`（0.1.3+ 的键）与 `text`（≤ 0.1.2-rc.1 的键，YAML 锚点共享同一份文案）——两个版本各读自己的键、忽略另一个（实测双键在两端 schema 均通过校验），一份文件覆盖目录式全区间。workflow 引擎行统一用 `@deepseek-ai/dsh-workflow`（其提供方在 0.1.2 → 0.2.x 全区间存在；旧版进程外变体 `dsh-workflow-worker-thread` 已从 0.1.6 起移除）。

## 卸载

- **路线 A**：插件管理器移除/停用 `dsh-novelist` bundle；如有遗留目录 `$HOME/.dsh/.agent-presets/novelist` 一并删除。
- **路线 B**：删除 `$HOME/.dsh/.agent-presets/novelist` 目录即可。

## 常见问题

- **预设选择器里没有「小说助手」？**
  - 路线 A：确认 `list_bundles` 列出了 `dsh-novelist`、`list_plugins` 的 `preset-novelist` 行无激活诊断；安装时目标必须是**包含 package.json 的仓库根目录**，而不是其中的某个子目录。
  - 路线 B：确认已完整复制（`skills/`、`templates/`、`webui/` 必须随行），且挂载校验通过；预设清单即时扫描，无需重启。
- **想改方法论？** 编辑 `skills/*/SKILL.md`（独立仓库 Novelist-Skills，以 submodule 挂载于 `skills/`）：路线 B 直接覆盖安装副本；路线 A 改后重装 bundle（或在仓库目录内 `git pull` 后按管理器的更新入口重装）。
- **DSH 升到 0.1.7+ 后预设消失了？** 这是预期行为：目录式预设在该区间被废弃。改走路线 A 重装一次即可。
- **网页管理端打不开？** 确认服务已启动（`novel_webui action=服务状态`，或看工程 `.webui/state.json` 与 `server.log`）；服务只监听 127.0.0.1，浏览器要在同一台机器上访问；启用了 token 时（`.webui/config.json`）页面会提示输入。
- **旧版本升级后工程模板/WebUI 不可用？** 路线 B 重新完整复制（旧指引只复制四样，缺 `templates/` 与 `webui/`）；路线 A 重装 bundle。
