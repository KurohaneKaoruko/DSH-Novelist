# 安装指引

本文件描述如何把 Novelist（小说助手）安装到 DeepSeek Harness。Agent 请按顺序执行；手动安装按同样步骤操作。

## 0. 环境确认

- DSH 用户预设根目录：`$HOME/.dsh/.agent-presets/`（Windows 即 `C:\Users\<用户名>\.dsh\.agent-presets\`；可用 `echo $env:DSH_HOME` 确认）。
- 预设通过**文件复制**安装（持久，进程重启与切换会话都不失效）。

## 1. 安装 Agent 预设「小说助手」（持久）

1. 把仓库根目录的全部内容（`preset.yml`、`agent.cordis.yml`、`plugins/`、`skills/`）复制到 `$HOME/.dsh/.agent-presets/novelist/`。
   - 该目录在会话工作区之外：若文件写入被沙箱拒绝，用 sandbox_permissions 重试一次（需用户批准）。
2. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过。

## 2. 收尾与使用

- 新建会话，在预设选择器中选择「**小说助手**」，确认：
  - 工具列表包含 `novel_lint` / `novel_check` / `novel_briefing` / `novel_archive` / `novel_project` / `novel_import` / `novel_scan_book`；
  - 技能列表包含 7 个 `novel-*` skill；
  - 系统提示包含「小说助手工作法」路由段。
- 建议开书流程：初始化工程 → 写 1-2 章定稿 → 提取文风卡 → 每章「简报 → 成稿 → 归档」闭环。

## 卸载

删除 `$HOME/.dsh/.agent-presets/novelist` 目录即可。

## 常见问题

- **预设选择器里没有「小说助手」？** 确认已完整复制（`skills/` 子目录必须随行），且挂载校验通过；预设清单即时扫描，无需重启。
- **想改方法论？** 直接编辑 `skills/*/SKILL.md` 后覆盖即可，Agent 亲写与工具成稿同时生效。
