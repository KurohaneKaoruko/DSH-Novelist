#!/usr/bin/env node
// tools/verify-acp-live.mjs — 交互式 ACP 验证（真实 pipe stdio）。
// （自 DSH-Novel 桌面端 scripts/verify-acp-live.mjs 迁移，用于验证「小说助手」预设。）
//
// 与 verify-kernel.mjs（文件重定向批处理式）互补：本脚本以命名管道与内核
// 交互，逐步发送请求并等待响应/通知。需要不受「pipe stdio EPERM」限制的执行环境。
//
// 用法：node verify-acp-live.mjs [--home .testhome] [--profile novel]

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
const profile = get("--profile", process.env.DSH_NOVEL_VERIFY_PROFILE || "novel");
const kernelBin = path.join(toolsDir, "kernel", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!fs.existsSync(kernelBin)) {
  console.error("[live] 内核未安装：npm run kernel:install");
  process.exit(1);
}
fs.mkdirSync(path.join(home, "workspace-demo"), { recursive: true });
await provisionHome(home, { log: () => {} });

const child = spawn(process.execPath, [kernelBin, "--profile", profile], {
  cwd: home,
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: "1" },
});

let nextId = 1;
const pending = new Map();
const notifications = [];
let buf = "";

child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log("[live:nonjson] " + line.slice(0, 160)); continue; }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(p.method + " → " + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      notifications.push(msg);
      console.log("[live:notify] " + msg.method + " " + JSON.stringify(msg.params ?? {}).slice(0, 500));
      // 服务器→客户端请求（如 session/request_permission）一律拒绝，避免挂起
      if (msg.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "verify client: not handled" } }) + "\n");
      }
    }
  }
});

let stderrTail = "";
child.stderr.on("data", (c) => { stderrTail = (stderrTail + c.toString("utf8")).slice(-4000); });
child.on("exit", (code, signal) => console.log("[live] 进程退出 code=" + code + " signal=" + signal));

function call(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(method + " 超时（" + Math.round(timeoutMs / 1000) + "s）— profile " + profile));
      }
    }, timeoutMs);
    const settle = (fn) => (arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
    child.stdin.write(frame);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on("exit", () => { try { child.kill(); } catch {} });

try {
  const t0 = Date.now();
  const init = await call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("[live] initialize OK (" + (Date.now() - t0) + "ms) protocolVersion=" + init.protocolVersion + " agent=" + JSON.stringify(init.agentInfo));

  const t1 = Date.now();
  const session = await call("session/new", { cwd: path.join(home, "workspace-demo"), mcpServers: {} }, 180000);
  console.log("[live] session/new OK (" + (Date.now() - t1) + "ms)");
  console.log("[live] session/new OK keys=" + Object.keys(session).join(","));
  console.log("[live] sessionId=" + session.sessionId);
  console.log("[live] configOptions=" + JSON.stringify(session.configOptions ?? null).slice(0, 800));
  if (session.models) console.log("[live] models=" + JSON.stringify(session.models).slice(0, 800));

  await sleep(1000);
  const list = await call("session/list", {});
  console.log("[live] session/list OK count=" + (list.sessions ? list.sessions.length : "?"));
  if (list.sessions && list.sessions[0]) console.log("[live] first=" + JSON.stringify(list.sessions[0]).slice(0, 500));

  const closed = await call("session/close", { sessionId: session.sessionId });
  console.log("[live] session/close OK " + JSON.stringify(closed).slice(0, 200));

  child.stdin.end();
  await sleep(2500);
  console.log("");
  console.log("PASS — 交互式 ACP 验证通过（profile=" + profile + "）");
  process.exit(0);
} catch (err) {
  console.error("[live] 失败：" + ((err && err.message) || err));
  if (stderrTail) console.error("--- stderr tail ---\n" + stderrTail);
  child.kill();
  process.exit(1);
}
