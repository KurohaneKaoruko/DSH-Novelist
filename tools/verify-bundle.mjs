#!/usr/bin/env node
// tools/verify-bundle.mjs — novelist 预设「bundle 路线」冒烟测试（DSH ≥ 0.1.7-alpha.1，含 0.2.x）。
//
// 目录式预设（$DSH_HOME/.agent-presets/）自 0.1.7-alpha.1 起不再被读取；该版本区间
// 的安装方式是 bundle：package.json 的 dsh.bundle.patch 指向 cordis.patch.yml，
// 其中的 @deepseek-ai/dsh-agent-preset 声明行内联整个插件列表。
//
// 本脚本模拟插件管理器 install_bundle 的最终落位：把 bundle 以 file: 依赖装进
// profile（node_modules/dsh-novelist/），profile 声明 bundles 含 dsh-novelist，
// 然后用真实内核按 ACP 启动，并由组合内探针插件（novelist-probe）直接盘问
// agentPresets registry —— roster / diagnostic / mount / skills 四级断言：
//   1. ROSTER 含 novelist 且无 broken；
//   2. novelist 的 diagnostic 为空（行级 schema 与 import 全部通过）；
//   3. presets.mount() 能把预设挂进一个新建 scope（bind 真实发生）；
//   4. 挂载后的 scoped skills 注册表能发现随包分发的 13 个 novel-* skill。
// 注意：ACP 层自身不接预设（web/desktop 的 api-session-controller 才是挂载方），
// 因此「session/new 成功」不构成证据，一切以探针读到的 registry 状态为准。
//
// 用法：node verify-bundle.mjs [--home .testhome-bundle] [--kernel kernel-verify]
//        [--profile novel-bundle] [--bundle-dir <dir>] [--node <node.exe>]

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = path.resolve(toolsDir, "..");
const args = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const home = path.resolve(toolsDir, get("--home", ".testhome-bundle"));
const kernelDirName = get("--kernel", "kernel-bundle");
const kernelDir = path.isAbsolute(kernelDirName) ? kernelDirName : path.join(toolsDir, kernelDirName);
const profile = get("--profile", "novel-bundle");
const nodeBin = get("--node", process.execPath);
// 被安装的 bundle 来源；默认仓库根目录。证伪实验可指向一个故意改坏的副本。
const bundleDir = path.resolve(toolsDir, get("--bundle-dir", repoRoot));
const kernelBin = path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

if (!fs.existsSync(kernelBin)) {
  console.error("[verify-bundle] 内核未安装：node kernel-install.mjs --version <ver> --at " + kernelDirName);
  process.exit(1);
}
const kernelPkg = JSON.parse(fs.readFileSync(path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"));

function fail(msg) {
  console.error("[verify-bundle] 失败：" + msg);
  process.exit(1);
}

// ---- provision：profile（含 file: 安装本 bundle + 探针行） -------------------

const profileDir = path.join(home, "profiles", profile);
fs.mkdirSync(profileDir, { recursive: true });

const profilePkg = {
  name: "dsh-profile-novel-bundle",
  private: true,
  dependencies: {
    // file: 安装 bundle 来源目录 —— 等价于插件管理器把本 bundle 装进 profile 的落位。
    "dsh-novelist": "file:" + bundleDir.split(path.sep).join("/"),
  },
  dsh: {
    profile: {
      bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-novelist"],
      patchReload: "startup",
    },
  },
};
fs.writeFileSync(path.join(profileDir, "package.json"), JSON.stringify(profilePkg, null, 2) + "\n", "utf8");

// 探针插件：组合内运行，inject agentPresets，把 registry 实况写到 stderr。
// （相对路径行锚定在 profile patch 文件旁 —— 即本目录。）
const probePlugin = `
export const name = "novelist-probe";
export const inject = ["agentPresets"];
export async function apply(ctx) {
  const presets = ctx.agentPresets;
  const out = (line) => process.stderr.write("[novelist-probe] " + line + "\\n");
  try {
    let list = [];
    for (let i = 0; i < 40; i++) {
      list = await presets.list();
      if (list.some((r) => r.id === "novelist")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    out("ROSTER " + JSON.stringify(list));
    const record = [...presets.definitions.values()].find((r) => r.config && r.config.id === "novelist");
    if (!record) { out("VERDICT FAIL no-novelist-record"); return; }
    const problem = await presets.diagnostic(record);
    out("DIAGNOSTIC " + (problem === undefined ? "(healthy)" : problem));
    // 挂载后的 scoped skills 读取（官方路径：acquireScope + skills.list({cwd, scope})，
    // 与 api-session-controller 完全一致）。
    const lease = await presets.acquireScope("novelist");
    try {
      const skills = ctx.get("skills");
      if (skills === undefined) {
        out("SKILLS absent");
      } else {
        const listed = await skills.list({ cwd: process.env.DSH_PROBE_CWD, scope: lease.key });
        out("SKILLS " + JSON.stringify((listed ?? []).map((s) => s.name).sort()));
      }
    } finally {
      await lease[Symbol.asyncDispose]();
    }
    out("VERDICT " + (problem === undefined ? "OK" : "BROKEN"));
  } catch (e) {
    out("VERDICT FAIL " + String((e && e.stack) || e).slice(0, 900));
  }
}
`;
fs.writeFileSync(path.join(profileDir, "novelist-probe.mjs"), probePlugin, "utf8");

const ws = path.join(home, "workspace-demo");
fs.mkdirSync(ws, { recursive: true });

const profilePatch = [
  "# novelist bundle 验证 profile（由 tools/verify-bundle.mjs 生成，请勿手改）。",
  "# 组合：dsh-base + dsh-acp-app（宿主层）+ agent-preset-registry（服务 agentPresets）",
  "# + dsh-novelist bundle 的声明层 + 探针行（最后一个 insert，等 registry 激活后运行）。",
  "",
  "# 部署级兜底人设：预设挂载失败时仍是写作 Agent 语义（正常路径由预设 persona 接管）。",
  "- id: system-prompt",
  "  config:",
  "    persona: >-",
  "      你是一个面向小说作者的写作智能体，由 {{model}} 驱动，当前工作目录是 {{cwd}}。",
  "",
  "# 预设名单提供方（bundle 的声明行 inject 本服务）。default 指向 novelist。",
  "- insert:",
  "    - id: agent-preset-registry",
  "      name: '@deepseek-ai/dsh-agent-preset-registry'",
  "      config:",
  "        default: novelist",
  "",
  "# 探针行：inject agentPresets，激活即盘问并落 stderr（断言由 verify-bundle 做）。",
  "- insert:",
  "    - id: novelist-probe",
  "      name: './novelist-probe.mjs'",
  "",
].join("\n");
fs.writeFileSync(path.join(profileDir, "cordis.patch.yml"), profilePatch, "utf8");

console.log("[verify-bundle] 内核: @deepseek-ai/dsh@" + kernelPkg.version);
console.log("[verify-bundle] home: " + home);
console.log("[verify-bundle] 在 profile 内安装 bundle（file: 依赖）…");
{
  // Windows 上 Node 禁止无 shell 直接 spawn .cmd —— 经 cmd.exe 调 npm。
  const npmArgs = ["install", "--no-audit", "--no-fund", "--loglevel", "error", "--cache", path.join(toolsDir, ".npm-cache")];
  const res = process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm"].concat(npmArgs), { cwd: profileDir, stdio: "pipe" })
    : spawnSync("npm", npmArgs, { cwd: profileDir, stdio: "pipe" });
  if (res.status !== 0) fail("profile 内 npm install 失败（exit " + res.status + "）\n" + String(res.stderr ?? ""));
}
const installedDir = path.join(profileDir, "node_modules", "dsh-novelist");
const installed = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"));
console.log("[verify-bundle] bundle 已装: dsh-novelist@" + installed.version);
console.log("[verify-bundle] patch 文件存在: " + fs.existsSync(path.join(installedDir, "cordis.patch.yml")));
console.log("[verify-bundle] 插件文件存在: " + fs.existsSync(path.join(installedDir, "plugins", "novel-tools.mjs")));
console.log("[verify-bundle] skills 目录存在: " + fs.existsSync(path.join(installedDir, "skills", "novel-craft", "SKILL.md")));

// ---- 启动内核，收集探针输出 ---------------------------------------------------

const child = spawn(nodeBin, [kernelBin, "--profile", profile], {
  cwd: home,
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PROBE_ANCHOR: path.join(kernelDir, "package.json"),
    DSH_PROBE_CWD: ws,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const probeLines = [];
const errChunks = [];
let finished = false;
child.stderr.on("data", (c) => {
  const text = c.toString("utf8");
  errChunks.push(text);
  for (const line of text.split("\n")) {
    if (line.startsWith("[novelist-probe]")) probeLines.push(line.slice("[novelist-probe] ".length));
  }
});
const errTail = () => Buffer.concat(errChunks.map((s) => Buffer.from(s))).toString("utf8").slice(-5000);
child.on("exit", (code) => {
  if (!finished) fail("内核提前退出（code=" + code + "）\nstderr:\n" + errTail());
});
child.stdout.on("data", () => {});
process.on("exit", () => { try { child.kill(); } catch {} });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verdictLine = () => probeLines.find((l) => l.startsWith("VERDICT"));

// 等探针给出结论（registry 激活 + mount + skills 盘点需要一些时间）。
let waited = 0;
while (verdictLine() === undefined && waited < 120000) {
  await sleep(500);
  waited += 500;
}

finished = true;
try { child.kill(); } catch {}

const verdict = verdictLine();
console.log("");
console.log("── 探针输出 ──");
for (const line of probeLines) console.log("  " + line.slice(0, 2000));
console.log("");

if (verdict === undefined) fail("探针 120s 内未给出 VERDICT。\nstderr:\n" + errTail());
if (!verdict.startsWith("VERDICT OK")) fail("探针判定失败：" + verdict + "\nstderr:\n" + errTail());

const rosterLine = probeLines.find((l) => l.startsWith("ROSTER "));
const roster = rosterLine ? JSON.parse(rosterLine.slice("ROSTER ".length)) : [];
const novelist = roster.find((r) => r.id === "novelist");
if (!novelist) fail("roster 无 novelist：" + rosterLine);
if (novelist.broken !== undefined) fail("novelist 带 broken 诊断：" + novelist.broken);
if (!rosterLine.includes('"name":"小说助手"') && novelist.name !== "小说助手") fail("novelist 显示名缺失");
const skillsLine = probeLines.find((l) => l.startsWith("SKILLS "));
const skillNames = skillsLine ? JSON.parse(skillsLine.slice("SKILLS ".length)) : [];
const expectedSkills = [
  "novel-ai-lexicon", "novel-analysis", "novel-continuity", "novel-craft", "novel-plotting",
  "novel-project", "novel-prose-standards",
  "novel-style-hotblood", "novel-style-lightnovel", "novel-style-mystery",
  "novel-style-romance", "novel-style-scifi", "novel-style-xianxia",
];
const missing = expectedSkills.filter((s) => !skillNames.includes(s));
if (missing.length > 0) fail("挂载后的 skills 缺少：" + missing.join(", ") + "（实际 " + skillNames.length + " 个）");

console.log("PASS — bundle 路线全链路挂载（dsh@" + kernelPkg.version + "）");
console.log("  roster: novelist（小说助手）在册且无 broken；diagnostic=(healthy)；acquireScope=ok");
console.log("  skills: " + skillNames.length + " 个 novel-* 全部经随包目录发现");
process.exit(0);
