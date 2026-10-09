#!/usr/bin/env node
// tools/verify-webui.mjs — WebUI 服务与工程模板冒烟验证。纯 node 标准库，无外部依赖。
//
// 验证内容（不需要 dsh 内核、不需要 API Key）：
//   1. 插件模块可加载（相对 import webui/lint.mjs 在包内解析成功）；
//   2. lint 共享模块行为正常（硬/软违规、章节正则）；
//   3. 工程模板目录完整（每个模板含 template.yml + 非空 files/）；
//   4. WebUI 服务单工程模式：state/overview/cards/card 写读/table/chapters
//      （含质量门禁拦截与 force）/search/lint/split 全链路；
//   5. WebUI 服务工作区模式：多工程发现与切换；
//   6. 服务停止（POST /api/shutdown + state.json 清理）。
//
// 用法：node verify-webui.mjs [--keep]（--keep 保留 .testhome-webui 便于排查）

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { spawn } from "node:child_process";

const toolsDir = path.resolve(url.fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = path.resolve(toolsDir, "..");
const testHome = path.join(toolsDir, ".testhome-webui");
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = false;
const ok = (msg) => console.log("  ✓ " + msg);
const fail = (msg) => { failed = true; console.error("  ✗ " + msg); };

async function api(pathname, { method = "GET", body, query } = {}) {
  const u = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v);
  const res = await fetch(u, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function spawnServer(args) {
  const child = spawn(process.execPath, [path.join(repoRoot, "webui", "server.mjs"), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  return child;
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await api("/api/state");
      if (r.status === 200) return r.data;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务 10s 内未就绪");
}

async function makeProject(dir, title) {
  await fsp.mkdir(path.join(dir, "正文"), { recursive: true });
  await fsp.mkdir(path.join(dir, "人物卡"), { recursive: true });
  await fsp.mkdir(path.join(dir, "设定集"), { recursive: true });
  await fsp.mkdir(path.join(dir, "大纲"), { recursive: true });
  await fsp.writeFile(path.join(dir, "README.md"), `# ${title}\n\n- 简介：测试工程\n`, "utf8");
  await fsp.writeFile(path.join(dir, "伏笔清单.md"), `# 伏笔清单\n\n| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |\n| --- | --- | --- | --- | --- |\n| 神秘令牌 | 第1章 | | | 铺设中 |\n`, "utf8");
  await fsp.writeFile(path.join(dir, "时间线.md"), `# 时间线\n\n| 时间 | 事件 | 参与人物 | 影响/后续 |\n| --- | --- | --- | --- |\n`, "utf8");
  await fsp.writeFile(path.join(dir, "大纲", "总纲.md"), "# 总纲\n\n## 主线\n\n（待填）\n", "utf8");
  await fsp.writeFile(path.join(dir, "人物卡", "林远.md"), "# 林远\n\n## 性格核心\n\n沉稳，话少。\n", "utf8");
  await fsp.writeFile(path.join(dir, "设定集", "力量体系.md"), "# 力量体系\n\n## 等级阶梯\n\n（待填）\n", "utf8");
  await fsp.writeFile(path.join(dir, "正文", "第001章-开局.md"), "夜雨敲窗。\n\n他数着檐水落下的节拍，把最后一枚铜钱推到桌子中央。\n", "utf8");
}

async function main() {
  console.log("verify-webui：WebUI 服务与工程模板冒烟");

  // 1. 插件模块加载（校验相对 import webui/lint.mjs 解析）
  await import(url.pathToFileURL(path.join(repoRoot, "plugins", "novel-tools.mjs")).href);
  ok("插件模块可加载（包内相对 import 解析成功）");

  // 2. 共享 lint 模块
  const lint = await import(url.pathToFileURL(path.join(repoRoot, "webui", "lint.mjs")).href);
  const bad = lint.lintText("他心中一沉。这是第一次，也是最后一次。「直角引号」");
  if (bad.hardCount >= 1 && bad.softCount >= 1) ok(`lint 硬/软违规检测正常（hard=${bad.hardCount} soft=${bad.softCount}）`);
  else fail("lint 规则异常：" + JSON.stringify({ hardCount: bad.hardCount, softCount: bad.softCount }));
  const clean = lint.lintText("雨停了。\n\n他把伞收起来，靠在门边。\n\n巷子深处有人喊他的名字，喊了两遍，没有第三遍。\n");
  if (clean.hardCount === 0) ok("干净文本不被误报硬违规");
  else fail("干净文本被误报：" + clean.report);
  if (lint.chapterHeadingRe.test("第十二章 夜行") && !lint.chapterHeadingRe.test("他走进第十二章")) ok("章节标题正则正常");

  // 3. 工程模板完整性
  const tplRoot = path.join(repoRoot, "templates");
  const tplIds = (await fsp.readdir(tplRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const expectedTpls = ["blank", "hotblood-xuanhuan", "mystery-suspense", "romance-sweet"];
  for (const id of expectedTpls) {
    if (!tplIds.includes(id)) fail(`缺少模板：${id}`);
    else if (!fs.existsSync(path.join(tplRoot, id, "template.yml"))) fail(`模板 ${id} 缺 template.yml`);
    else {
      const filesDir = path.join(tplRoot, id, "files");
      if (!fs.existsSync(filesDir) || fs.readdirSync(filesDir).length === 0) fail(`模板 ${id} files/ 为空`);
      else ok(`模板 ${id} 完整（template.yml + files/）`);
    }
  }
  const blankReadme = await fsp.readFile(path.join(tplRoot, "blank", "files", "README.md"), "utf8");
  if (blankReadme.includes("{{title}}")) ok("模板变量（{{title}}）就位");
  else fail("blank 模板缺少 {{title}} 变量");

  // ---- 准备夹具工程 ----
  await fsp.rm(testHome, { recursive: true, force: true });
  const projA = path.join(testHome, "书A");
  const projB = path.join(testHome, "书B");
  await makeProject(projA, "测试作品甲");
  await makeProject(projB, "测试作品乙");

  // 4. 单工程模式全链路
  let child = spawnServer(["--project", projA, "--port", String(PORT)]);
  try {
    const st = await waitReady();
    if (st.mode === "project" && st.version) ok(`单工程模式启动（v${st.version}）`);
    else fail("state 异常：" + JSON.stringify(st));

    const ov = await api("/api/overview");
    if (ov.data.name === "测试作品甲" && ov.data.stats.chapters === 1 && ov.data.stats.characters === 1) ok("overview 统计正确");
    else fail("overview 异常：" + JSON.stringify(ov.data.stats || ov));
    if (ov.data.spec === "obsidian") ok("未装 .webui 的工程识别为 obsidian 规范");

    const cards = await api("/api/cards", { query: { type: "人物卡" } });
    if (cards.data.length === 1 && cards.data[0].name === "林远" && cards.data[0].sections.includes("性格核心")) ok("人物卡列表与小节解析正确");

    const put = await api("/api/card", { method: "PUT", body: { file: "人物卡/林远.md", raw: "# 林远\n\n## 性格核心\n\n沉稳，话少，记账。\n" } });
    if (put.status === 200) ok("卡片保存成功");
    const back = await fsp.readFile(path.join(projA, "人物卡", "林远.md"), "utf8");
    if (back.includes("记账")) ok("保存直接落盘到工程 md（唯一事实源）");

    const newCard = await api("/api/card", { method: "POST", body: { type: "设定集", name: "地理" } });
    if (newCard.status === 200 && fs.existsSync(path.join(projA, "设定集", "地理.md"))) ok("新建设定卡（脚手架）成功");

    const tbl = await api("/api/table", { query: { file: "伏笔清单.md" } });
    if (tbl.data.rows.length === 1 && tbl.data.rows[0][0] === "神秘令牌") ok("伏笔表解析正确");
    const badTbl = await api("/api/table", { method: "PUT", body: { file: "伏笔清单.md", header: ["错误表头"], rows: [["x"]] } });
    if (badTbl.status >= 400) ok("伏笔表表头校验拒收（与 novel_archive 同门禁）");
    else fail("坏表头未被拒收");
    const goodTbl = await api("/api/table", { method: "PUT", body: { file: "大纲/剧情线.md", header: ["线名", "类型", "状态", "起点", "终点", "关键节点"], rows: [["主线", "主线", "铺设中", "第1章", "", "开局"]] } });
    if (goodTbl.status === 200) ok("剧情线表格写入成功");

    // 章节门禁：硬违规拒绝 + force 放行
    const dirty = "他心中一沉！！「不行。」";
    const gate = await api("/api/chapter", { method: "POST", body: { num: 2, title: "测试", raw: dirty } });
    if (gate.status === 422 && String(gate.data.error).includes("硬违规")) ok("章节保存门禁拦截硬违规");
    else fail("门禁未拦截：" + JSON.stringify(gate.data));
    const forced = await api("/api/chapter", { method: "POST", body: { num: 2, title: "测试", raw: dirty, force: true } });
    if (forced.status === 200 && fs.existsSync(path.join(projA, "正文", "第002章-测试.md"))) ok("force 豁免后落盘成功");
    else fail("force 落盘失败：" + JSON.stringify(forced.data));

    const chapters = await api("/api/chapters");
    if (chapters.data.length === 2 && chapters.data[1].num === 2) ok("章节列表与序号解析正确");

    const sr = await api("/api/search", { query: { q: "铜钱" } });
    if (sr.data.length === 1 && sr.data[0].file === "正文/第001章-开局.md") ok("全文搜索命中正确");

    const lr = await api("/api/tool/lint", { method: "POST", body: { text: dirty } });
    if (lr.status === 200 && lr.data.hardCount >= 1) ok("工具箱 AI 味检查可用（与插件同源）");

    const sp = await api("/api/tool/split", { method: "POST", body: { text: "第一章 起点\n\n内容甲。\n\n第二章 转折\n\n内容乙。", start: 5 } });
    if (sp.data.length === 2 && sp.data[0].num === 5 && sp.data[1].num === 6) ok("旧稿分章规则与起始章号正确");
    else fail("分章异常：" + JSON.stringify(sp.data));

    // 白名单：路径穿越与越界写入被拒
    const evil = await api("/api/card", { method: "PUT", body: { file: "../escape.md", raw: "x" } });
    if (evil.status >= 400) ok("路径穿越被拒绝");
    else fail("路径穿越未被拒绝");

    // state.json 就绪标记
    const stateFile = path.join(projA, ".webui", "state.json");
    if (fs.existsSync(stateFile)) ok("state.json 就绪标记写入（Agent 工具据此探测）");
  } finally {
    await api("/api/shutdown", { method: "POST" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    try { child.kill("SIGKILL"); } catch {}
  }
  if (!fs.existsSync(path.join(projA, ".webui", "state.json"))) ok("停止后 state.json 已清理");
  else fail("state.json 未清理");

  // 5. 工作区模式
  child = spawnServer(["--workspace", testHome, "--port", String(PORT)]);
  try {
    const st = await waitReady();
    const ids = st.projects.map((p) => p.id);
    if (st.mode === "workspace" && ids.includes("书A") && ids.includes("书B")) ok(`工作区模式发现 ${st.projects.length} 个工程`);
    else fail("工程发现异常：" + JSON.stringify(st.projects));

    const ovB = await api("/api/overview", { query: { project: "书B" } });
    if (ovB.data.name === "测试作品乙") ok("多工程切换（project 参数）正确");
    else fail("工程切换异常：" + JSON.stringify(ovB.data));
  } finally {
    await api("/api/shutdown", { method: "POST" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    try { child.kill("SIGKILL"); } catch {}
  }

  // 6. 插件层新路径：用模拟 Cordis 上下文驱动 novel_project / novel_webui
  {
    const projC = path.join(testHome, "书C");
    // 工作区自定义模板（优先于内置）
    await fsp.mkdir(path.join(projC, "templates", "custom-x", "files"), { recursive: true });
    await fsp.writeFile(path.join(projC, "templates", "custom-x", "template.yml"), "id: custom-x\nname: 自定义模板\ndescription: 工作区模板优先级验证\n", "utf8");
    await fsp.writeFile(path.join(projC, "templates", "custom-x", "files", "自定义.md"), "# {{title}} 自定义\n", "utf8");

    const registered = {};
    const fakeFs = {
      async resolve(rel, opts = {}) { return path.resolve(opts && opts.cwd ? opts.cwd : projC, rel); },
      async readText(target) { return fsp.readFile(target, "utf8"); },
      async writeText(target, text) { await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, text, "utf8"); },
      async listDir(target) {
        const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => []);
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      },
    };
    const ctx = {
      get(name) {
        if (name === "fs") return fakeFs;
        if (name === "sandboxPolicy") return { resolve: () => ({}), workspaceRoot: projC };
        return undefined;
      },
      tools: { register: (def) => { registered[def.name] = def; return () => {}; } },
      systemPrompt: { section: (s) => ({ name: s.name, dispose: () => {} }) },
    };
    const plugin = (await import(url.pathToFileURL(path.join(repoRoot, "plugins", "novel-tools.mjs")).href)).default;
    plugin.apply(ctx);
    const call = (name, args) => registered[name].execute(args, undefined).then((r) => r.result);
    try {
      const list = await call("novel_project", { action: "查询模板" });
      if (list.includes("custom-x") && list.includes("hotblood-xuanhuan") && list.includes("blank")) ok("查询模板：内置 + 工作区自定义都列出");
      else fail("查询模板异常：" + list.slice(0, 200));

      await call("novel_project", { action: "初始化工程", title: "工作区模板之作", template: "custom-x", 规范: "obsidian" });
      const custom = await fsp.readFile(path.join(projC, "自定义.md"), "utf8");
      if (custom.includes("工作区模板之作")) ok("初始化工程：工作区模板拉取 + {{title}} 变量替换");
      else fail("模板变量替换异常：" + custom);

      await call("novel_project", { action: "初始化工程", title: "玄幻之作", template: "hotblood-xuanhuan", 规范: "webui" });
      const has = async (p) => fs.existsSync(path.join(projC, p));
      if (await has("大纲/爽点规划.md") && await has("人物卡/主角.md") && await has("设定集/力量体系.md")) ok("初始化工程：内容模板整套落盘");
      else fail("模板落盘不完整");
      if (await has(".webui/server.mjs") && await has(".webui/index.html") && await has(".webui/lint.mjs") && await has(".webui/config.json")) ok("规范=webui：WebUI 资产安装到 .webui/");
      else fail(".webui 资产安装不完整");
      const webuiReadme = await fsp.readFile(path.join(projC, "README.md"), "utf8");
      if (webuiReadme.includes("玄幻之作") && webuiReadme.includes("[[大纲/爽点规划|爽点规划]]")) ok("模板 README 按 {{title}} 生成");
      else fail("模板 README 异常");

      // 幂等升级：安装服务 重复执行不报错
      await call("novel_webui", { action: "安装服务" });
      ok("novel_webui 安装服务幂等");

      // 启动 → 状态 → 停止（真实分离进程，独立端口避开上面的用例）
      const started = await call("novel_webui", { action: "启动服务", 范围: "工程", port: 4398 });
      if (started.includes("http://127.0.0.1:4398/") && started.includes("已启动")) ok("novel_webui 启动服务（分离进程 + 就绪探测）");
      else fail("启动服务输出异常：" + started.slice(0, 300));
      const again = await call("novel_webui", { action: "启动服务", port: 4399 });
      if (again.includes("已在运行")) ok("重复启动被识别为幂等（返回现有地址）");
      else fail("重复启动未幂等：" + again.slice(0, 200));
      const status = await call("novel_webui", { action: "服务状态" });
      if (status.includes("运行中")) ok("服务状态探测正常");
      const stopped = await call("novel_webui", { action: "停止服务" });
      if (stopped.includes("已停止")) ok("novel_webui 停止服务 + 状态清理");
      else fail("停止服务异常：" + stopped);
    } finally {
      // 兜底停掉可能残留的服务进程
      try {
        const st = JSON.parse(await fsp.readFile(path.join(projC, ".webui", "state.json"), "utf8"));
        process.kill(st.pid, "SIGKILL");
      } catch {}
    }
  }

  console.log(failed ? "\nFAIL — verify-webui 存在失败项" : "\nPASS — WebUI 服务与工程模板全部通过");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-webui 异常退出：" + ((e && e.stack) || e));
  process.exit(1);
});
