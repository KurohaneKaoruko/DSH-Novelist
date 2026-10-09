#!/usr/bin/env node
// 小说工程 WebUI 服务——零依赖轻量 Web 管理端（只使用 Node 内建模块，Node ≥ 18）。
// -----------------------------------------------------------------------------
// 三种启动方式（等价）：
//   1. Agent 工具：novel_webui action=启动服务（推荐，自动安装/升级 .webui/ 并后台拉起）
//   2. 手动（工程内自带副本）：node .webui/server.mjs --project <作品根目录>
//   3. 手动（多工程集中管理）：node .webui/server.mjs --workspace <工作区目录>
//
// 设计约束：
//   - md 文件是唯一事实源。本服务只做确定性读写/解析/检查，不做任何模型生成；
//     网页、Obsidian、文件工具编辑的是同一批 md 文件，随时混用。
//   - 默认只监听 127.0.0.1。绑定非回环地址时强制要求访问令牌（--token）。
//   - 写操作白名单：只允许根目录 *.md 与 大纲/ 人物卡/ 设定集/ 正文/ 归档/ 下的
//     *.md，写入走「临时文件 + 原子替换」，并保留 .md 之外的任何东西不动。

import http from 'node:http';
import fsp from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';
import { lintText, chapterHeadingRe } from './lint.mjs';

export const VERSION = '1.1.0';

// ---------------- 参数与配置 ----------------

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}

function absDir(p, label) {
  if (!p || typeof p !== 'string') throw fail(`缺少 --${label} 参数`, 2);
  const r = path.resolve(String(p));
  let st;
  try { st = fsSync.statSync(r); } catch { throw fail(`目录不存在：${r}`, 2); }
  if (!st.isDirectory()) throw fail(`不是目录：${r}`, 2);
  return r;
}

async function loadConfig(root) {
  // 可选配置：<root>/.webui/config.json（命令行参数优先）
  const file = path.join(root, '.webui', 'config.json');
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch { return {}; }
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------------- 工程发现与访问 ----------------

const ALLOWED_TOPS = ['大纲', '人物卡', '设定集', '正文', '归档'];

// 是否长得像一个小说工程（初始化工程的目录约定）
function looksLikeProject(dir) {
  try {
    if (!fsSync.statSync(path.join(dir, 'README.md')).isFile()) return false;
  } catch { return false; }
  if (fsSync.existsSync(path.join(dir, '.webui'))) return true;
  for (const sub of ALLOWED_TOPS) {
    try { if (fsSync.statSync(path.join(dir, sub)).isDirectory()) return true; } catch {}
  }
  return false;
}

// 发现工作区下的小说工程（深度 1；隐藏目录跳过）
function discoverProjects(workspace) {
  const out = [];
  let entries;
  try { entries = fsSync.readdirSync(workspace, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir = path.join(workspace, e.name);
    if (looksLikeProject(dir)) out.push({ id: e.name, name: e.name, dir });
  }
  return out;
}

function charCount(text) { return String(text || '').replace(/\s+/g, '').length; }

function safeStem(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, '').trim();
}

// 单个工程的文件访问层：路径白名单 + 原子写
function openProject(proj) {
  const dir = proj.dir;
  const toAbs = (rel) => path.join(dir, ...rel.split('/'));

  function safeRel(p) {
    if (typeof p !== 'string' || !p.trim()) throw fail('缺少文件路径');
    if (path.isAbsolute(p)) throw fail(`非法路径：${p}`);
    if (p.replace(/\\/g, '/').split('/').some((seg) => seg === '..')) throw fail(`非法路径：${p}`);
    let norm = path.normalize(p).replace(/\\/g, '/').replace(/^[./]+/, '').trim();
    if (!norm || norm.split('/').some((seg) => seg === '..')) throw fail(`非法路径：${p}`);
    if (!norm.toLowerCase().endsWith('.md')) throw fail(`只允许访问 .md 文件：${norm}`);
    const top = norm.split('/')[0];
    const inWhite = top === 'README.md' || (!norm.includes('/') && top.endsWith('.md')) || ALLOWED_TOPS.includes(top);
    if (!inWhite) throw fail(`路径不在白名单内（允许：根目录 md、${ALLOWED_TOPS.join('、')}）：${norm}`);
    return norm;
  }

  return {
    ...proj,
    safeRel,
    async readMd(rel) {
      try { return await fsp.readFile(toAbs(rel), 'utf8'); } catch { return null; }
    },
    async writeMd(rel, content) {
      const abs = toAbs(rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
      await fsp.writeFile(tmp, content, 'utf8');
      await fsp.rename(tmp, abs);
      return rel;
    },
    async deleteMd(rel) {
      await fsp.rm(toAbs(rel), { force: true });
    },
    async listMd(sub, { keepIndex = false } = {}) {
      let entries;
      try { entries = await fsp.readdir(toAbs(sub), { withFileTypes: true }); } catch { return []; }
      return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name !== '说明.md')
        .map((e) => e.name)
        .filter((n) => keepIndex || n !== '_索引.md')
        .sort((a, b) => a.localeCompare(b, 'zh'));
    },
    async statMd(rel) {
      try { const st = await fsp.stat(toAbs(rel)); return { mtime: st.mtimeMs, size: st.size }; } catch { return {}; }
    },
  };
}

// ---------------- Markdown 解析 ----------------

function firstHeading(raw) {
  const m = String(raw || '').match(/^#\s+(.+)\s*$/m);
  return m ? m[1].trim() : '';
}

function firstSnippet(raw) {
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('|') || t.startsWith('>')) continue;
    return t.length > 64 ? `${t.slice(0, 64)}…` : t;
  }
  return '';
}

function headings(raw) {
  const out = [];
  for (const m of String(raw || '').matchAll(/^##\s+(.+)\s*$/gm)) out.push(m[1].trim());
  return out;
}

// 解析文件中第一个 Markdown 表格 → { header, rows }（无表格返回 null）
function parseTable(raw) {
  const lines = String(raw || '').split('\n');
  const block = [];
  for (const line of lines) {
    if (line.trim().startsWith('|')) block.push(line.trim());
    else if (block.length) break;
  }
  if (block.length < 2) return null;
  const cells = (l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const header = cells(block[0]);
  const rows = block.slice(1)
    .filter((l) => !/^\|[\s:|-]+\|?$/.test(l))
    .map(cells);
  if (!header.length) return null;
  return { header, rows };
}

function serializeTable(header, rows) {
  const esc = (c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const line = (cells) => `| ${cells.map(esc).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

// 把表格写回文件：文件里已有表格 → 原位替换第一张表；没有 → 追加在标题后
async function writeTable(proj, rel, header, rows) {
  const raw = (await proj.readMd(rel)) ?? `# ${path.basename(rel, '.md')}\n`;
  const table = serializeTable(header, rows);
  const lines = raw.split('\n');
  let start = -1; let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|')) {
      start = i;
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) j += 1;
      end = j;
      break;
    }
  }
  const next = start >= 0
    ? [...lines.slice(0, start), table, ...lines.slice(end)].join('\n')
    : `${raw.trimEnd()}\n\n${table}\n`;
  await proj.writeMd(rel, next);
}

const chapterNumOf = (file) => {
  const n = parseInt((file.match(/^第(\d+)章/) || [])[1], 10);
  return Number.isNaN(n) ? null : n;
};

const chapterTitleOf = (file) => file.replace(/^第\d+章/, '').replace(/\.md$/, '').replace(/^-/, '');

// ---------------- API 路由 ----------------

function makeApi(state) {
  const pickProject = (q) => {
    const id = q.get('project');
    if (!id) return state.projects[0];
    const p = state.projects.find((x) => x.id === id);
    if (!p) throw fail(`未知工程：${id}`, 404);
    return p;
  };

  async function cardList(proj, type) {
    if (!ALLOWED_TOPS.includes(type)) throw fail(`type 只允许：${ALLOWED_TOPS.join('、')}`);
    const names = await proj.listMd(type);
    const out = [];
    for (const name of names) {
      const rel = `${type}/${name}`;
      const raw = await proj.readMd(rel);
      if (raw === null) continue;
      const st = await proj.statMd(rel);
      out.push({
        name: name.replace(/\.md$/, ''),
        file: rel,
        title: firstHeading(raw) || name.replace(/\.md$/, ''),
        snippet: firstSnippet(raw),
        sections: headings(raw),
        chars: charCount(raw),
        mtime: st.mtime || 0,
      });
    }
    return out;
  }

  const CARD_SCAFFOLD = {
    人物卡: (n) => `# ${n}\n\n## 基本信息\n\n（姓名/年龄/身份/外貌特征）\n\n## 性格核心\n\n（2-3 个核心特质，各配一个具体行为例证）\n\n## 口癖与说话方式\n\n（语言指纹：句长习惯、口头禅、称呼方式、避讳用词）\n\n## 动机与目标\n\n（想要什么、为什么、愿意付出什么代价）\n\n## 关系\n\n（与其他人物的羁绊，用 [[双链]] 关联，如 [[主角]]）\n\n## 当前状态\n\n（跟随剧情更新：所在位置/伤势/持有物/知道的信息）\n\n## 弧光预埋\n\n（成长弧线：起点缺陷 → 触发事件 → 终点变化）\n`,
    设定集: (n) => `# ${n}\n\n（设定要点；与人物卡和其他设定用双链互相关联，如 [[主角]]、[[设定集/力量体系|力量体系]]）\n\n## 概述\n\n## 规则与限制\n\n## 已出场章节\n`,
  };

  async function overview(proj) {
    const chapters = await chapterList(proj);
    const chars = await cardList(proj, '人物卡');
    const sets = await cardList(proj, '设定集');
    const archives = await proj.listMd('归档');
    const foreshadow = parseTable(await proj.readMd('伏笔清单.md') || '');
    let open = 0;
    if (foreshadow) {
      const idx = foreshadow.header.indexOf('状态');
      for (const r of foreshadow.rows) {
        if (!r.length || r.every((c) => !c || c.startsWith('---'))) continue;
        const st = idx >= 0 ? String(r[idx] || '') : '';
        if (!/已回收|已揭示|完结/.test(st)) open += 1;
      }
    }
    return {
      id: proj.id,
      name: firstHeading(await proj.readMd('README.md') || '') || proj.name,
      dir: proj.dir,
      spec: fsSync.existsSync(path.join(proj.dir, '.webui', 'server.mjs')) ? 'webui' : 'obsidian',
      stats: {
        chapters: chapters.length,
        totalChars: chapters.reduce((s, c) => s + c.chars, 0),
        characters: chars.length,
        settings: sets.length,
        archives: archives.length,
        foreshadowTotal: foreshadow ? foreshadow.rows.length : 0,
        foreshadowOpen: open,
      },
      recentChapters: chapters.slice(-5).reverse(),
      recentArchives: archives.slice(-5).reverse().map((n) => n.replace(/\.md$/, '')),
    };
  }

  async function chapterList(proj) {
    const names = await proj.listMd('正文');
    const out = [];
    for (const name of names) {
      const rel = `正文/${name}`;
      const raw = await proj.readMd(rel);
      if (raw === null) continue;
      const st = await proj.statMd(rel);
      out.push({ num: chapterNumOf(name), file: rel, name, title: chapterTitleOf(name), chars: charCount(raw), mtime: st.mtime || 0 });
    }
    out.sort((a, b) => (a.num ?? 9e9) - (b.num ?? 9e9));
    return out;
  }

  async function search(proj, q) {
    if (!q) throw fail('缺少查询词 q');
    const hits = [];
    // 根目录 md + 四个内容目录逐个扫
    const targets = [];
    for (const n of await fsp.readdir(proj.dir).catch(() => [])) {
      if (n.toLowerCase().endsWith('.md') && n !== '说明.md') targets.push(n);
    }
    for (const sub of ALLOWED_TOPS) {
      for (const n of await proj.listMd(sub, { keepIndex: true })) targets.push(`${sub}/${n}`);
    }
    const needle = q.toLowerCase();
    for (const rel of targets) {
      const raw = await proj.readMd(rel);
      if (!raw) continue;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
          if (hits.length >= 120) return hits;
        }
      }
    }
    return hits;
  }

  // 旧稿分章（与 novel_import 同一条规则）
  function splitManuscript(text, start) {
    const chapters = [];
    let cur = null;
    for (const rawLine of String(text || '').split('\n')) {
      const line = rawLine.trim();
      if (chapterHeadingRe.test(line)) {
        if (cur) chapters.push(cur);
        cur = { title: line, body: [] };
      } else {
        if (!cur) cur = { title: '', body: [] };
        cur.body.push(rawLine);
      }
    }
    if (cur) chapters.push(cur);
    const base = Number.isInteger(start) && start > 0 ? start : 1;
    return chapters
      .map((c) => ({ title: c.title, body: c.body.join('\n').trim() }))
      .filter((c) => c.title || c.body)
      .map((c, i) => {
        const clean = c.title.replace(/^第[0-9零一二三四五六七八九十百千两]+[章回节]\s*[:：、.\-—]?\s*/, '');
        const num = base + i;
        const gate = lintText(c.body || '');
        return { num, title: clean, chars: charCount(c.body), hardCount: gate.hardCount, softCount: gate.softCount };
      });
  }

  async function route(method, u, body) {
    const q = u.searchParams;
    const p = q.get('project') ? pickProject(q) : null;
    switch (`${method} ${u.pathname}`) {
      case 'GET /api/state': {
        return {
          version: VERSION,
          mode: state.mode,
          root: state.root,
          projects: state.projects.map(({ id, name }) => ({ id, name })),
        };
      }
      case 'GET /api/overview': {
        return overview(pickProject(q));
      }
      case 'GET /api/cards': {
        return cardList(pickProject(q), q.get('type') || '人物卡');
      }
      case 'GET /api/card': {
        const proj = pickProject(q);
        const rel = proj.safeRel(q.get('file') || '');
        const raw = await proj.readMd(rel);
        if (raw === null) throw fail('文件不存在', 404);
        return { file: rel, raw };
      }
      case 'PUT /api/card': {
        const proj = pickProjectObj(body);
        const rel = proj.safeRel(body.file || '');
        if (typeof body.raw !== 'string') throw fail('缺少 raw');
        await proj.writeMd(rel, body.raw);
        return { ok: true, file: rel };
      }
      case 'POST /api/card': {
        const proj = pickProjectObj(body);
        const type = body.type === '设定集' ? '设定集' : '人物卡';
        const stem = safeStem(body.name || '');
        if (!stem) throw fail('缺少卡片名 name');
        const rel = `${type}/${stem}.md`;
        if (await proj.readMd(rel) !== null) throw fail(`已存在：${rel}`);
        const scaffold = (CARD_SCAFFOLD[type] || CARD_SCAFFOLD.设定集)(stem);
        await proj.writeMd(rel, scaffold);
        return { ok: true, file: rel };
      }
      case 'DELETE /api/card': {
        const proj = pickProject(q);
        const rel = proj.safeRel(q.get('file') || '');
        if (rel === 'README.md' || !rel.includes('/')) throw fail('只允许删除目录内的卡片文件');
        await proj.deleteMd(rel);
        return { ok: true };
      }
      case 'GET /api/chapters': {
        return chapterList(pickProject(q));
      }
      case 'GET /api/chapter': {
        const proj = pickProject(q);
        const rel = proj.safeRel(q.get('file') || '');
        const raw = await proj.readMd(rel);
        if (raw === null) throw fail('章节不存在', 404);
        return { file: rel, raw };
      }
      case 'PUT /api/chapter': {
        // 修改已有章节：同样过 lint 门禁（可 force）
        const proj = pickProjectObj(body);
        const rel = proj.safeRel(body.file || '');
        if (!rel.startsWith('正文/')) throw fail('只允许修改 正文/ 下的章节');
        const gate = gateCheck(body);
        await proj.writeMd(rel, body.raw);
        return { ok: true, file: rel, ...gate };
      }
      case 'POST /api/chapter': {
        // 新建章节：按 第NNN章-标题.md 命名，内置质量门禁
        const proj = pickProjectObj(body);
        const num = Number(body.num);
        if (!Number.isInteger(num) || num <= 0) throw fail('缺少章节序号 num');
        const title = safeStem(body.title || '');
        const existing = await proj.listMd('正文');
        const clash = existing.find((n) => chapterNumOf(n) === num);
        if (clash) throw fail(`第 ${num} 章已存在（${clash}）。修改已有章节请用 PUT /api/chapter。`);
        const gate = gateCheck(body);
        const rel = `正文/第${String(num).padStart(3, '0')}章${title ? '-' + title : ''}.md`;
        await proj.writeMd(rel, String(body.raw || ''));
        return { ok: true, file: rel, ...gate };
      }
      case 'GET /api/table': {
        const proj = pickProject(q);
        const rel = proj.safeRel(q.get('file') || '');
        const raw = await proj.readMd(rel) || '';
        const t = parseTable(raw);
        return { file: rel, header: t ? t.header : [], rows: t ? t.rows : [], exists: await proj.readMd(rel) !== null };
      }
      case 'PUT /api/table': {
        const proj = pickProjectObj(body);
        const rel = proj.safeRel(body.file || '');
        if (!Array.isArray(body.header) || !body.header.length) throw fail('缺少表头 header');
        if (!Array.isArray(body.rows)) throw fail('缺少行 rows');
        // 格式门禁：伏笔清单表头必须含「伏笔」（与 novel_archive 一致）
        if (path.basename(rel) === '伏笔清单.md' && !body.header.join('|').includes('伏笔')) {
          throw fail('伏笔清单表头必须包含「伏笔」列');
        }
        await writeTable(proj, rel, body.header, body.rows);
        return { ok: true };
      }
      case 'GET /api/outline': {
        const proj = pickProject(q);
        const names = await proj.listMd('大纲', { keepIndex: true });
        const files = [];
        for (const n of names) {
          const rel = `大纲/${n}`;
          const raw = await proj.readMd(rel);
          files.push({ file: rel, name: n.replace(/\.md$/, ''), title: firstHeading(raw) || n.replace(/\.md$/, ''), chars: charCount(raw) });
        }
        return files;
      }
      case 'GET /api/search': {
        return search(pickProject(q), q.get('q'));
      }
      case 'POST /api/tool/lint': {
        const text = String((body || {}).text || '');
        if (!text.trim()) throw fail('缺少 text');
        const r = lintText(text);
        return { chars: charCount(text), hardCount: r.hardCount, softCount: r.softCount, report: r.report };
      }
      case 'POST /api/tool/split': {
        const b = body || {};
        return splitManuscript(String(b.text || ''), b.start);
      }
      case 'POST /api/shutdown': {
        // process.exit 不触发 SIGTERM 处理器，这里自行清理运行状态
        setTimeout(() => {
          fsp.rm(state.stateFile || '', { force: true }).catch(() => {}).finally(() => process.exit(0));
        }, 120);
        return { ok: true };
      }
      default:
        throw fail(`未知接口：${method} ${u.pathname}`, 404);
    }
  }

  function pickProjectObj(body) {
    const id = body && body.project;
    const proj = id ? state.projects.find((x) => x.id === id) : state.projects[0];
    if (!proj) throw fail(id ? `未知工程：${id}` : '没有可用工程', 404);
    return proj;
  }

  function gateCheck(body) {
    const raw = String((body || {}).raw || '');
    const r = lintText(raw);
    if (r.hardCount > 0 && body.force !== true) {
      throw fail(`【保存被门禁拦截】正文存在 ${r.hardCount} 项硬违规：\n${r.report}\n\n逐句修复后重试；确需带伤保存请传 force: true。`, 422);
    }
    return { hardCount: r.hardCount, softCount: r.softCount, report: r.report, forced: body.force === true && r.hardCount > 0 };
  }

  return route;
}

// ---------------- HTTP 服务 ----------------

function readBody(req, cap = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(fail('请求体过大', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(buf);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const mode = flags.workspace ? 'workspace' : 'project';
  const root = absDir(flags.workspace || flags.project, flags.workspace ? 'workspace' : 'project');
  const cfg = await loadConfig(root);

  const host = String(flags.host || cfg.host || '127.0.0.1');
  let port = Number(flags.port || cfg.port || 4311);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) port = 4311;
  let token = String(flags.token || cfg.token || '');
  const nonLoopback = !['127.0.0.1', '::1', 'localhost'].includes(host);
  if (nonLoopback && !token) token = crypto.randomBytes(9).toString('base64url');

  const found = mode === 'workspace'
    ? discoverProjects(root)
    : [{ id: 'default', name: path.basename(root), dir: root }];
  if (mode === 'workspace' && !found.length) {
    console.error(`[webui] 工作区 ${root} 下没有发现小说工程（识别条件：含 README.md 且含 大纲/人物卡/设定集/正文 任一目录）。`);
  }
  const projectsOpened = found.map((p) => openProject(p));

  const state = { mode, root, projects: projectsOpened };
  const api = makeApi(state);
  const indexHtml = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'index.html');

  const checkToken = (req, u) => {
    if (!token) return true;
    const h = req.headers.authorization || '';
    return h === `Bearer ${token}` || u.searchParams.get('token') === token;
  };

  const server = http.createServer(async (req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad url' }); }
    try {
      if (!u.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' || !['/', '/index.html'].includes(u.pathname)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        const html = await fsp.readFile(indexHtml, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }
      if (!checkToken(req, u)) return sendJson(res, 401, { error: '需要访问令牌（Authorization: Bearer <token> 或 ?token=）' });
      const body = ['POST', 'PUT'].includes(req.method) ? JSON.parse((await readBody(req)) || '{}') : null;
      const out = await api(req.method, u, body);
      return sendJson(res, 200, out ?? { ok: true });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: (err && err.message) || String(err) });
    }
  });

  // 端口被占用时向后顺延（最多 20 个）
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (flags.port) throw fail(`端口 ${port} 已被占用`, 2);
      port += 1;
    }
  }

  // 运行状态落盘：Agent 工具据此探测就绪/停止服务
  const stateDir = path.join(root, '.webui');
  fsSync.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  state.stateFile = stateFile;
  await fsp.writeFile(stateFile, `${JSON.stringify({
    pid: process.pid,
    version: VERSION,
    mode,
    root,
    host,
    port,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`,
    tokenSet: Boolean(token),
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  const banner = [
    `[webui] 小说工程 WebUI 服务 v${VERSION}`,
    `[webui] 模式：${mode === 'workspace' ? `工作区（${projectsOpened.length} 个工程）` : '单工程'} · 根目录：${root}`,
    `[webui] 地址：http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`,
    token ? '[webui] 访问令牌：已启用（请求需带 Authorization: Bearer <token>）' : '[webui] 访问令牌：未启用（仅本机回环监听）',
    '[webui] md 文件是唯一事实源；网页与 Obsidian、文件工具编辑同一批文件。停止：POST /api/shutdown 或杀掉本进程。',
  ].join('\n');
  console.log(banner);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await fsp.rm(stateFile, { force: true }).catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[webui] 启动失败：' + ((err && err.message) || err));
  process.exit(err.status || 1);
});
