# tools/ —— 预设验证工具链

改完预设（人设 / 工具 / skill）之后，用真实 dsh 内核冒烟验证「小说助手」两条安装路线
仍可正常挂载（自 DSH-Novel 桌面端迁移；不需要 API Key，不发起 LLM 调用）。

```bash
npm run kernel:install          # 安装目录式验证内核 tools/kernel/（@deepseek-ai/dsh@0.1.2-rc.1，首次 / 升级时）
npm run verify:kernel           # 目录式路线冒烟（0.1.2；--kernel 可换 0.1.6 等其他目录式内核）
npm run kernel:install:bundle   # 安装 bundle 验证内核 tools/kernel-bundle/（@deepseek-ai/dsh@0.2.0-rc.2）
npm run verify:bundle           # bundle 路线冒烟（≥ 0.1.7；--kernel 可换 0.1.7-rc.2 等）
npm run verify:acp              # 交互式冒烟（真实 pipe stdio；需普通终端环境，目录式）
```

## 验证原理（硬断言，不是「能启动就行」）

两个验证脚本都会向 profile 注入一个组合内探针插件（`novelist-probe`，inject
`agentPresets`），由它把运行时实况写到 stderr，脚本再据此断言：

1. **roster**：预设名单含 `novelist`（显示名「小说助手」）且无 `broken`；
2. **挂载诊断**：旧代 `ensureStanding` / 新代 `diagnostic` 为空（行级 import 与
   config 全部通过——「session/new 成功」在两代内核上都不构成证据，静默容忍是
   DSH 的真实行为）；
3. **scoped skills**：沿官方读取路径（`standingKeyFor`/`acquireScope` +
   `skills.list({cwd, scope})`）断言 13 个 `novel-*` skill 全部可发现。

改动断言后务必做一次证伪（把安装副本改坏，确认判定翻转为 FAIL）。

- 目录式测试 HOME 在 `tools/.testhome*/`（不入库）；`provision-home.mjs` 会把仓库内的
  预设（preset.yml、agent.cordis.yml、plugins/、skills/ 四样）安装进去并生成
  `novel` profile（含探针行）。用户手改过的安装副本不会被覆盖（重装加 `--force`）。
- bundle 测试 HOME 同上；`verify-bundle.mjs` 把仓库根目录以 `file:` 依赖装进
  profile（模拟插件管理器 install_bundle 的落位），profile 声明 bundles 含
  `dsh-novelist`，随后由探针断言。
- 内核版本：目录式钉在 `kernel/package.json`（`@deepseek-ai/dsh@0.1.2-rc.1`），
  bundle 钉在 `npm run kernel:install:bundle`（`0.2.0-rc.2`）；
  `node_modules/` 与 `.npm-cache/` 均不入库。
- 兼容分界线（实测）：persona 键名 `text`→`prefix` 分界在 0.1.2→0.1.3-alpha.2；
  预设安装机制（目录→bundle 声明）分界在 0.1.6-alpha.2→0.1.7-alpha.1；
  `dsh-workflow-worker-thread` 包止于 0.1.5-rc.3（组合内已统一改用全区间存在的
  `@deepseek-ai/dsh-workflow`）。
- CI 在 `.github/workflows/verify.yml`：push 即自动跑两条路线的冒烟验证。
