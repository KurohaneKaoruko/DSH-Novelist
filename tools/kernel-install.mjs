#!/usr/bin/env node
// tools/kernel-install.mjs — 在 tools/kernel/ 内安装钉住版本的 DeepSeek Harness 内核。
// （自 DSH-Novel 桌面端 scripts/kernel-install.mjs 迁移，改为服务 novelist 预设验证。）
//
// 用法：node kernel-install.mjs [--prod]
// 产物：kernel/node_modules/@deepseek-ai/dsh/lib/bin.js（dsh CLI 入口，不入库）

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const kernelDir = path.join(toolsDir, "kernel");
const binPath = path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const args = ["install", "--no-audit", "--no-fund", "--cache", path.join(toolsDir, ".npm-cache")];
// 受限沙箱（pipe/spawn 被禁）里生命周期脚本会 EPERM —— 显式选择跳过。
// 注意：跳过后 POSIX 上 node-pty 的 spawn-helper 会失去可执行位，
// 下面有手动 chmod 兜底；正常环境请勿设置该变量。
if (process.env.DSH_NOVEL_SKIP_SCRIPTS === "1") args.push("--ignore-scripts");
if (process.argv.includes("--prod")) args.push("--omit=dev");

console.log("[kernel-install] npm install in tools/kernel/ ...");
// Windows 上 Node 禁止无 shell 直接 spawn .cmd —— 经 cmd.exe 调 npm。
const res = process.platform === "win32"
  ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm"].concat(args), { cwd: kernelDir, stdio: "inherit" })
  : spawnSync("npm", args, { cwd: kernelDir, stdio: "inherit" });
if (res.status !== 0) {
  console.error("[kernel-install] npm install 失败（exit " + res.status + "）");
  process.exit(res.status ?? 1);
}
if (!fs.existsSync(binPath)) {
  console.error("[kernel-install] 未找到内核入口：" + binPath);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(path.join(kernelDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"));

// 兜底：恢复 node-pty spawn-helper 的可执行位（等价于 dsh-subprocess-local 的 postinstall）。
const ptyDir = path.join(kernelDir, "node_modules", "node-pty");
const helper = path.join(ptyDir, "prebuilds", process.platform + "-" + process.arch, "spawn-helper");
if (fs.existsSync(helper)) {
  try {
    fs.chmodSync(helper, 0o755);
    console.log("[kernel-install] spawn-helper 已 chmod 755");
  } catch (e) {
    console.warn("[kernel-install] spawn-helper chmod 失败（Windows 可忽略）：" + e.message);
  }
}

console.log("[kernel-install] OK — @deepseek-ai/dsh@" + pkg.version);
console.log("[kernel-install] bin: " + binPath);
