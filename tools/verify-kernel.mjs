#!/usr/bin/env node
// tools/verify-kernel.mjs — novelist 预设内核冒烟测试（无人值守批处理式）。
// （自 DSH-Novel 桌面端 scripts/verify-kernel.mjs 迁移；原版经文件重定向喂 ACP 帧，
//   但 stdin 文件读尽即 EOF，内核会在 session/new 应答前静默退出——现改为
//   pipe stdio 顺序问答，本地与 CI 均稳定。交互式排查用 verify-acp-live.mjs。）
//
// 流程：kernel/ 安装 → provision 测试 home（安装预设 + novel profile）→
// "dsh --profile novel"（ACP stdio）执行 initialize / session/new / session/list /
// session/close → stdin EOF 优雅退出。不需要 API Key（不发起 LLM 调用）。
// 验证点：agent.cordis.yml 可挂载、plugins 可加载、skills/ 随行、预设语义生效。
//
// 用法：node verify-kernel.mjs [--home .testhome] [--node <node.exe>]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { provisionHome } from "./provision-home.mjs";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const get = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : dflt;
};
const home = path.resolve(toolsDir, get("--home", ".testhome"));
const nodeBin = get("--node", process.execPath);
const kernelBin = path.join(toolsDir, "kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

if (!fs.existsSync(kernelBin)) {
  console.error("[verify] 内核未安装，先运行：npm run kernel:install");
  process.exit(1);
}

const ws = path.join(home, "workspace-demo");
fs.mkdirSync(ws, { recursive: true });

console.log("[verify] node: " + nodeBin);
console.log("[verify] home: " + home);
const counts = await provisionHome(home, { log: (m) => console.log("[provision] " + m) });
console.log("[verify] provision: " + JSON.stringify(counts));

// ---- ACP 顺序问答（pipe stdio） ---------------------------------------------

const child = spawn(nodeBin, [kernelBin, "--profile", "novel"], {
  cwd: home,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

// stdout/stderr 同步落盘（失败诊断用），行缓冲供应答匹配。
const outFile = path.join(home, ".acp-out.jsonl");
const errFile = path.join(home, ".acp-err.log");
const outLog = fs.createWriteStream(outFile);
const errChunks = [];
child.stdout.on("data", (c) => outLog.write(c));
child.stderr.on("data", (c) => errChunks.push(c));
const errTail = () => Buffer.concat(errChunks).toString("utf8").slice(-3000);
child.on("exit", (code) => {
  if (!finished) fail("内核提前退出（code=" + code + "）\nstderr:\n" + errTail());
});

let nextId = 1;
const pending = new Map();
let finished = false;
function fail(msg) {
  finished = true;
  console.error("[verify] 失败：" + msg);
  try { child.kill(); } catch {}
  process.exit(1);
}

function call(method, params, timeoutMs) {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(method + " 超时（" + Math.round(timeoutMs / 1000) + "s）\nstderr:\n" + errTail()));
    }, timeoutMs);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      method,
    });
    child.stdin.write(frame);
  });
}

// 内核 → 客户端请求（如 session/request_permission）一律拒绝，避免挂起。
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    const p = pending.get(msg.id);
    if (p && (msg.result !== undefined || msg.error !== undefined)) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(p.method + " → " + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.method && msg.id !== undefined) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "verify client: not handled" } }) + "\n");
    }
  }
});

process.on("exit", () => { try { child.kill(); } catch {} });

try {
  let t = Date.now();
  const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} }, 60000);
  console.log("[verify] initialize OK：" + (Date.now() - t) + "ms protocolVersion=" + init.protocolVersion);
  console.log("         agentInfo: " + JSON.stringify(init.agentInfo));

  t = Date.now();
  const session = await call("session/new", { cwd: ws, mcpServers: {} }, 180000);
  console.log("[verify] session/new OK：" + (Date.now() - t) + "ms sessionId=" + session.sessionId);
  console.log("         configOptions: " + JSON.stringify(session.configOptions).slice(0, 600));

  const list = await call("session/list", {}, 60000);
  console.log("[verify] session/list OK：sessions=" + (list.sessions ? list.sessions.length : "?"));

  await call("session/close", { sessionId: session.sessionId }, 60000);
  console.log("[verify] session/close OK");

  child.stdin.end();
  finished = true;
  outLog.end();
  await new Promise((r) => child.on("exit", r));
  console.log("");
  console.log("PASS — 内核 ACP 链路可用（profile=novel，默认预设 novelist）");
  process.exit(0);
} catch (err) {
  fail((err && err.message) || String(err));
}
