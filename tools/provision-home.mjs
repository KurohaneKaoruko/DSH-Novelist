#!/usr/bin/env node
// tools/provision-home.mjs — 组装一个用于验证 novelist 预设的 DSH_HOME。纯 node 标准库。
// （自 DSH-Novel 桌面端 scripts/provision-home.mjs 迁移收窄：只服务本预设，无应用打包逻辑。）
//
// 职责（幂等）：
//   1. profiles/novel：写作 profile（bundles = dsh-base + dsh-acp-app，挂
//      agent-presets roster，default 指向 novelist）；
//   2. .agent-presets/novelist：安装仓库内的「小说助手」预设（preset.yml、
//      agent.cordis.yml、plugins/、skills/ 四样，tools/ 等开发件不随行）——
//      只覆盖「本工具安装且未被用户修改」的副本；用户改过或外来预设一律跳过。
//
// 用法：node provision-home.mjs --home <dir> [--force]
// 导出：provisionHome(home, opts) → 计数对象

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import url from "node:url";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const presetRoot = path.resolve(toolsDir, "..");
const STAMP_NAME = ".novelist-verify.json";
const PRESET_KEY = "novelist";
const PRESET_ITEMS = ["preset.yml", "agent.cordis.yml", "plugins", "skills"];

function sha256buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// 预设内容指纹：只算四样组成部分（排序后的 相对路径 + 文件内容），排除 stamp 自身。
function presetHash(baseDir) {
  const h = crypto.createHash("sha256");
  const add = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(abs).sort()) add(path.join(abs, e), rel + "/" + e);
    } else {
      h.update(rel);
      h.update("\0");
      h.update(fs.readFileSync(abs));
      h.update("\0");
    }
  };
  for (const rel of PRESET_ITEMS) {
    const p = path.join(baseDir, rel);
    if (!fs.existsSync(p)) return null;
    add(p, rel);
  }
  return h.digest("hex");
}

function copyPreset(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of PRESET_ITEMS) {
    const src = path.join(presetRoot, rel);
    const out = path.join(dest, rel);
    if (fs.statSync(src).isDirectory()) {
      fs.rmSync(out, { recursive: true, force: true });
      fs.cpSync(src, out, { recursive: true });
    } else {
      fs.copyFileSync(src, out);
    }
  }
}

function readStamp(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STAMP_NAME), "utf8"));
  } catch {
    return null;
  }
}

function writeStamp(dir, hash) {
  const body = JSON.stringify({ source: "novelist-verify", treeHash: hash }, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, STAMP_NAME), body, "utf8");
}

// ---- profile --------------------------------------------------------------

function profilePatchYml() {
  return [
    "# novelist 验证 profile：小说助手（由 tools/provision-home.mjs 生成，请勿手改）。",
    "# 组合：dsh-base + dsh-acp-app（ACP stdio 服务）+ agent-presets roster + 探针行。",
    "",
    "# 部署级兜底人设：预设挂载失败时仍是写作 Agent 语义（正常路径由预设 persona 接管）。",
    "- id: system-prompt",
    "  config:",
    "    persona: >-",
    "      你是一个面向小说作者的写作智能体，由 {{model}} 驱动，当前工作目录是 {{cwd}}。",
    "",
    "# 预设名单：随附根 + <dshHome>/.agent-presets（includeUserRoot 默认开启）。",
    "- insert:",
    "    - id: agent-presets",
    "      name: '@deepseek-ai/dsh-agent-presets'",
    "      config:",
    "        default: " + PRESET_KEY,
    "",
    "# 探针行：inject agentPresets，激活即盘问 roster/mount/skills 并落 stderr",
    "# （verify-kernel 据此做硬断言；相对路径行锚定在本 profile 目录）。",
    "    - id: novelist-probe",
    "      name: './novelist-probe.mjs'",
    "",
  ].join("\n");
}

// 组合内探针插件：两代 roster API 通吃——
//   ≤ 0.1.6 目录式：dsh-agent-presets（list/resolveMountable/ensureStanding/standingKeyFor）
//   ≥ 0.1.7 声明式：dsh-agent-preset-registry（list/diagnostic/acquireScope）
// 激活后把 roster、挂载诊断与 scoped skills 清单写到 stderr，供验证脚本断言。
const probePluginSource = [
  'export const name = "novelist-probe";',
  'export const inject = ["agentPresets"];',
  'export async function apply(ctx) {',
  '  const out = (l) => process.stderr.write("[novelist-probe] " + l + "\\n");',
  "  try {",
  "    const presets = ctx.agentPresets;",
  "    const list = await presets.list();",
  '    const rows = (list ?? []).map((r) => ({ id: r.id, name: r.name, broken: r.broken }));',
  '    out("ROSTER " + JSON.stringify(rows));',
  '    const row = rows.find((r) => r.id === "novelist");',
  '    if (!row) { out("VERDICT FAIL no-novelist-row"); return; }',
  '    if (row.broken !== undefined) { out("VERDICT FAIL broken: " + row.broken); return; }',
  "    let problem;",
  "    if (presets.definitions) {",
  "      const record = [...presets.definitions.values()].find((r) => r.config && r.config.id === \"novelist\");",
  '      problem = record ? await presets.diagnostic(record) : "no record";',
  "    } else if (presets.resolveMountable) {",
  "      try {",
  '        const preset = await presets.resolveMountable("novelist");',
  "        await presets.ensureStanding(preset);",
  "      } catch (e) { problem = String((e && e.message) || e); }",
  "    }",
  '    out("DIAGNOSTIC " + (problem === undefined ? "(healthy)" : problem));',
  "    if (problem === undefined) {",
  '      const skills = ctx.get("skills");',
  '      if (skills === undefined) out("SKILLS absent");',
  "      else {",
  "        let scope;",
  "        try {",
  "          scope = presets.standingKeyFor ? await presets.standingKeyFor(\"novelist\")",
  "            : presets.acquireScope ? (await presets.acquireScope(\"novelist\")).key : undefined;",
  "        } catch {}",
  "        const listed = await skills.list({ cwd: process.env.DSH_PROBE_CWD, scope });",
  '        out("SKILLS " + JSON.stringify((listed ?? []).map((s) => s.name).sort()));',
  "      }",
  "    }",
  '    out("VERDICT " + (problem === undefined ? "OK" : "BROKEN"));',
  "  } catch (e) {",
  '    out("VERDICT FAIL " + String((e && e.stack) || e).slice(0, 900));',
  "  }",
  "}",
  "",
].join("\n");

function ensureProfile(home, log) {
  const dir = path.join(home, "profiles", "novel");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "novelist-probe.mjs"), probePluginSource, "utf8");
  const pkg = {
    name: "dsh-profile-novel",
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"],
        // 自定义 profile 默认 patchReload=live（需 Cordis HMR 服务，ACP 组合里没有，
        // 会导致 session/new 即崩）；验证场景用 startup：仅启动时应用 patch 一次。
        patchReload: "startup",
      },
    },
  };
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), profilePatchYml(), "utf8");
  log("profile novel → 预设 " + PRESET_KEY);
}

// ---- 预设安装 --------------------------------------------------------------

function installPreset(home, force, log) {
  const dest = path.join(home, ".agent-presets", PRESET_KEY);
  if (force) {
    fs.rmSync(dest, { recursive: true, force: true });
    copyPreset(dest);
    writeStamp(dest, presetHash(dest));
    log("预设 " + PRESET_KEY + "：强制重装");
    return "forced";
  }
  if (!fs.existsSync(dest)) {
    copyPreset(dest);
    writeStamp(dest, presetHash(dest));
    log("预设 " + PRESET_KEY + "：安装");
    return "installed";
  }
  const stamp = readStamp(dest);
  if (!stamp || stamp.source !== "novelist-verify") {
    log("预设 " + PRESET_KEY + "：已存在（非本工具安装），跳过");
    return "skipped";
  }
  const currentHash = presetHash(dest);
  if (currentHash !== stamp.treeHash) {
    log("预设 " + PRESET_KEY + "：用户已修改，跳过（重装请 --force）");
    return "skipped";
  }
  const sourceHash = presetHash(presetRoot);
  if (sourceHash && currentHash !== sourceHash) {
    copyPreset(dest);
    writeStamp(dest, presetHash(dest));
    log("预设 " + PRESET_KEY + "：更新到最新版本");
    return "updated";
  }
  return "uptodate";
}

// ---- 主入口 ----------------------------------------------------------------

export async function provisionHome(home, opts = {}) {
  const force = !!opts.force;
  const log = opts.log || (() => {});
  home = path.resolve(home);

  for (const rel of PRESET_ITEMS) {
    if (!fs.existsSync(path.join(presetRoot, rel))) {
      throw new Error("预设缺少组成部分：" + path.join(presetRoot, rel));
    }
  }

  fs.mkdirSync(path.join(home, ".agent-presets"), { recursive: true });
  ensureProfile(home, log);

  const counts = {};
  const r = installPreset(home, force, log);
  counts[r] = (counts[r] || 0) + 1;
  return counts;
}

// ---- CLI -------------------------------------------------------------------

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const home = get("--home");
  const force = args.includes("--force");
  if (!home) {
    console.error("用法：provision-home.mjs --home <dir> [--force]");
    process.exit(2);
  }
  provisionHome(home, { force, log: (m) => console.log("[provision] " + m) })
    .then((c) => console.log("[provision] 完成 " + JSON.stringify(c)))
    .catch((e) => {
      console.error("[provision] 失败：" + ((e && e.message) || e));
      process.exit(1);
    });
}
