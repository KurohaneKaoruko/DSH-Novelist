# tools/ —— 预设验证工具链

改完预设（人设 / 工具 / skill）之后，用真实 dsh 内核冒烟验证「小说助手」仍可正常
挂载与会话（自 DSH-Novel 桌面端迁移；不需要 API Key，不发起 LLM 调用）。

```bash
npm run kernel:install   # 安装钉版 dsh 内核到 tools/kernel/（首次 / 升级时）
npm run verify:kernel    # 批处理式冒烟：initialize / session/new / list / close
npm run verify:acp       # 交互式冒烟（真实 pipe stdio；需普通终端环境）
```

- 测试 HOME 在 `tools/.testhome/`（不入库）；`provision-home.mjs` 会把仓库内的
  预设（preset.yml、agent.cordis.yml、plugins/、skills/ 四样）安装进去并生成
  `novel` profile。用户手改过的安装副本不会被覆盖（重装加 `--force`）。
- 内核版本钉在 `kernel/package.json`（`@deepseek-ai/dsh@0.1.2-rc.1`）；
  `node_modules/` 与 `.npm-cache/` 均不入库。
- CI 在 `.github/workflows/verify.yml`：push 即自动跑同一套冒烟验证。
