// 小说助手内置工具插件（随“小说助手”预设一起安装）
// -----------------------------------------------------------------------------
// 由 agent.cordis.yml 中的相对路径行 './plugins/novel-tools.mjs' 加载。
//
// 架构铁律：工具零模型调用。
// - 一切模型生成（正文/大纲/人设/文风卡/归档提取/分析）由 Agent 本体完成——
//   Agent 是链路里最强、上下文最全的写手，且不引入独立子调用的失败模式。
// - 工具只做代码擅长的事：
//   · novel_lint      确定性 AI 味检查（纯代码规则，秒回不耗模型）
//   · novel_briefing  写前材料组装（读工程文件，返回结构化原始材料）
//   · novel_archive   归档落盘（Agent 按格式提取三段更新，工具原子写入）
//   · novel_project   作品工程文件操作（查询/拉取工程模板、obsidian|webui 双
//                     规范初始化、保存/统计/索引）
//   · novel_import    旧稿分章落盘（纯代码分章；逆推由 Agent 按 skill 完成）
//   · novel_scan_book 体检材料组装（选章+汇总工程材料，分析由 Agent 完成）
//   · novel_webui     WebUI 服务管理（把零依赖网页管理端装进工程 .webui/ 并
//                     后台拉起，支持单工程与多工程工作区）
// - 写前材料 → Agent 亲写（生成时防味干预）→ novel_lint 自检循环 → 落盘 →
//   novel_archive，构成每章闭环；方法论全部住在 skills/ 目录。
//
// 工程规范（spec）：obsidian=纯 Markdown（Obsidian 友好）；webui=同一批 md
// 文件之上叠加轻量 Web 服务（.webui/，md 仍是唯一事实源）。工程模板
// （templates/）是数据化的工程骨架，Agent 查询后按 id 整套拉取。
//
// 只使用 Node 内建模块与 Cordis 上下文服务（不 import 外部 npm 包，预设目录
// 在用户主目录下无法解析 node_modules）。相对路径 import 仅指向本包内的
// webui/lint.mjs（正文铁律检查的唯一实现，与 WebUI 服务共享同一套规则）。

import fsMod from 'node:fs';
import pathMod from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintText, chapterHeadingRe } from '../webui/lint.mjs';

// 预设/包自身安装位（plugins/ 的上一级）：工程模板与 WebUI 资产的读取来源。
const pkgRoot = fileURLToPath(new URL('../', import.meta.url));
const WEBUI_ASSETS = ['server.mjs', 'index.html', 'lint.mjs'];
const WEBUI_VERSION_RE = /^export const VERSION = '([^']+)';/m;

// ---------------- 共享工具函数 ----------------

// 把声明式参数 DSL 编译为原始 JSON Schema（供模型可见的 parameters 使用）
function compileParams(spec) {
  const properties = {};
  const required = [];
  for (const key of Object.keys(spec)) {
    const prop = { ...spec[key] };
    if (prop.required === true) {
      required.push(key);
      delete prop.required;
    }
    properties[key] = prop;
  }
  return { type: 'object', properties, required };
}

// 章节文件名里的标题需要去掉文件系统不安全字符
function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|\r\n]/g, '').trim();
}

export default {
  name: 'novel-tools',
  inject: ['tools', 'systemPrompt'],
  apply(ctx) {
    const disposers = [];

    // ---------------- 工程文件访问 ----------------
    function workspaceRoot(exec, sp) {
      const session = exec && exec.agent ? exec.agent.session : undefined;
      return session && session.header && typeof session.header.cwd === 'string' && session.header.cwd
        ? session.header.cwd
        : (sp.workspaceRoot && sp.workspaceRoot.length ? sp.workspaceRoot : '.');
    }
    // 打开作品工程：读取（缺文件容错）、列 Markdown、写入三件套。工程目录约定：
    // 正文/（每章一个文件）、大纲/、设定集/、人物卡/、归档/、伏笔清单.md、时间线.md、README.md。
    // 各目录下由初始化生成的 说明.md 是脚手架，列目录时跳过。
    function openProject(fs, root, policy) {
      const readMaybe = async (rel, cap) => {
        try {
          const target = await fs.resolve(rel, { cwd: root });
          let text = await fs.readText(target);
          if (cap && text.length > cap) text = `${text.slice(0, cap)}\n…（已截断）`;
          return text;
        } catch (err) { return null; }
      };
      const listMd = async (dir) => {
        try {
          const target = await fs.resolve(dir, { cwd: root });
          const entries = await fs.listDir(target);
          return entries
            .filter((e) => e.type === 'file' && /\.md$/.test(e.name) && e.name !== '说明.md')
            .map((e) => e.name).sort();
        } catch (err) { return []; }
      };
      const write = async (rel, text) => {
        const target = await fs.resolve(rel, { cwd: root });
        await fs.writeText(target, text, undefined, undefined, policy);
        return rel;
      };
      // 章节文件按“第NNN章”序号排序取最新一篇；number 给定时取序号小于它的最后一章
      const latestChapter = async (number) => {
        const names = await listMd('正文');
        const parsed = names
          .map((n) => ({ n, num: parseInt((n.match(/^第(\d+)章/) || [])[1], 10) }))
          .filter((c) => !Number.isNaN(c.num) && (number === undefined || number === null || c.num < number));
        if (!parsed.length) return null;
        parsed.sort((a, b) => a.num - b.num);
        return parsed[parsed.length - 1].n;
      };
      const chapterTail = async (number, chars) => {
        const name = await latestChapter(number);
        if (!name) return null;
        const text = await readMaybe(`正文/${name}`);
        if (!text) return null;
        return { name, tail: text.length > chars ? text.slice(-chars) : text };
      };
      // 取指定章之前 count 章的结尾（按章号升序返回），用于多章前文参考
      const recentChapterTails = async (number, count, tailChars) => {
        const names = await listMd('正文');
        const parsed = names
          .map((n) => ({ n, num: parseInt((n.match(/^第(\d+)章/) || [])[1], 10) }))
          .filter((c) => !Number.isNaN(c.num) && (number === undefined || number === null || c.num < number));
        parsed.sort((a, b) => a.num - b.num);
        const picked = parsed.slice(-Math.max(1, count));
        const outList = [];
        for (const p of picked) {
          const text = await readMaybe(`正文/${p.n}`);
          if (!text) continue;
          outList.push({ name: p.n, num: p.num, tail: text.length > tailChars ? text.slice(-tailChars) : text });
        }
        return outList;
      };
      return { readMaybe, listMd, write, latestChapter, chapterTail, recentChapterTails };
    }
    // 保存一章正文到 正文/第NNN章-标题.md，返回相对路径
    async function saveChapterFile(fs, root, policy, num, title, body) {
      const file = `正文/第${String(num).padStart(3, '0')}章${title ? '-' + safeName(title) : ''}.md`;
      const target = await fs.resolve(file, { cwd: root });
      await fs.writeText(target, body, undefined, undefined, policy);
      return file;
    }
    // 解析文件系统执行上下文（fs 服务 + 工作区根 + 会话沙箱策略）；不可用时返回 null
    function fsContext(exec) {
      const fs = ctx.get('fs');
      const sp = ctx.get('sandboxPolicy');
      if (fs === undefined || sp === undefined) return null;
      const session = exec && exec.agent ? exec.agent.session : undefined;
      return { fs, root: workspaceRoot(exec, sp), policy: sp.resolve(session !== undefined ? { session } : {}) };
    }

    // ---------------- 确定性 AI 味检查（纯代码，不调用模型） ----------------
    // 实现在本包 webui/lint.mjs（与 WebUI 服务共享同一套规则，一处维护）：
    // 能量化的铁律（标点、禁词、副词/极端词频次、句式频次、比喻密度、句长波动、
    // 同句式连用）交给代码逐条核对，模型自查只兜底不可量化项（视角越界、情绪
    // 标签、说明书腔）。返回 { hardCount, softCount, report }。

    // 工具注册工厂：spec = { name, description, parameters, run, timeoutMs? }
    function tool(spec) {
      const def = {
        name: spec.name,
        description: spec.description,
        parameters: compileParams(spec.parameters),
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        output: {
          schema: { type: 'object', properties: { result: { type: 'string' } }, additionalProperties: false },
          render(args, value) { return [{ type: 'text', text: value.result }]; },
        },
        async execute(args, exec) {
          const result = await spec.run(args, exec);
          return { result };
        },
      };
      disposers.push(ctx.tools.register(def));
    }

    // ---------------- 1. AI 味确定性检查 ----------------
    tool({
      name: 'novel_lint',
      description: 'AI 味与正文铁律确定性检查（纯代码规则，不调用模型，秒回）：标点纪律（破折号/省略号/感叹号/分号）、简体网文标点规范（直角引号/英文引号/错误省略号/装饰符号）、禁用词与模板化表达（含第二代伪外化：呼吸一滞/喉结滚动等）、数字装具体类套话、万能量词、副词与次高频词频次、极端词密度、句式频次、AI 转折词与论文腔、比喻引导词密度、句长均匀度（变异系数）、连续同句式开头、心理描写密度、对话标签密度、段尾总结句、章末模板收尾、Markdown 残留。亲写正文后必跑；hard 项必须修，soft 项逐条核对（可能有误报）。',
      timeoutMs: 30000,
      parameters: {
        text: { type: 'string', description: '待检查的正文', required: true },
      },
      run: async (args) => {
        const text = args && typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('缺少待检查文本（text）');
        const { hardCount, softCount, report } = lintText(text);
        const chars = text.replace(/\s+/g, '').length;
        const verdict = hardCount > 0 ? `发现 ${hardCount} 项硬违规，必须修（按清单逐句修复后可再跑一次复查）。` : '无硬违规。';
        const softLine = softCount > 0 ? `另有 ${softCount} 项软违规，建议逐条核对（禁词/频次类规则偶有语境误报，误报可忽略）。` : '';
        return `【正文铁律检查】（${chars} 字 · 确定性规则 · 未调用模型）\n\n${report}\n\n${verdict}${softLine}`;
      },
    });

    // ---------------- 2. 名词一致性核对 ----------------
    // 类比代码的「未知标识符检查」：从工程文件自动构建名词档案（人物卡、设定集
    // 文件名及其小节标题、伏笔清单词条），再扫描正文：
    // ① 已建档名词的覆盖情况；② 反复出现却不在任何档案里的高频词——它们要么是
    // 忘记建档的新设定，要么是普通用词，逐个确认即可杜绝凭空编造。
    tool({
      name: 'novel_check',
      description: '名词一致性核对（纯代码，零模型调用）：从工程自动构建名词档案（人物卡名、设定集分类与小节、伏笔词条），然后核对正文——①哪些已建档名词在本章出现；②哪些高频词（出现 ≥3 次的双到四字词）不在任何档案里。后者要么是忘记建档的新设定（先补档案再定稿），要么是普通用词（忽略）。写完一章、保存之前运行，配合 novel_lint 使用：lint 管文风，本工具管设定出处。',
      timeoutMs: 60000,
      parameters: {
        text: { type: 'string', description: '待核对的章正文', required: true },
        chapter_number: { type: 'integer', description: '本章序号（可选；用于检查章节序号是否跳跃）' },
      },
      run: async (args, exec) => {
        const text = args && typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('缺少待核对文本（text）');
        const occursIn = (s, w) => s.split(w).length - 1;
        const fc = fsContext(exec);
        const lines = [];
        let registryCount = 0;
        let covered = [];
        let unknown = [];
        if (fc) {
          const proj = openProject(fc.fs, fc.root, fc.policy);
          // 1) 构建名词档案
          const registry = new Set();
          const charNames = (await proj.listMd('人物卡')).filter((c) => c !== '_索引.md').map((c) => c.replace(/\.md$/, ''));
          const setNames = (await proj.listMd('设定集')).filter((s) => s !== '_索引.md' && s !== '说明.md').map((s) => s.replace(/\.md$/, ''));
          for (const n of charNames) registry.add(n);
          for (const n of setNames) registry.add(n);
          for (const s of setNames.slice(0, 12)) {
            const content = await proj.readMaybe(`设定集/${s}.md`, 3000);
            if (!content) continue;
            for (const m of content.matchAll(/^#{2,3}\s+(.+)$/gm)) {
              const h = m[1].trim();
              if (h && h.length >= 2 && h.length <= 12) registry.add(h);
            }
          }
          const foreshadow = await proj.readMaybe('伏笔清单.md', 3000);
          if (foreshadow) {
            for (const row of foreshadow.split('\n')) {
              if (!row.trim().startsWith('|')) continue;
              const cell = row.split('|')[1];
              if (cell) {
                const term = cell.trim();
                if (term && term !== '伏笔' && term.length >= 2 && term.length <= 12 && !term.includes('---')) registry.add(term);
              }
            }
          }
          // 2) 已建档名词覆盖
          const sorted = [...registry].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length);
          for (const t of sorted) {
            const n = occursIn(text, t);
            if (n > 0) { covered.push(`“${t}”×${n}`); registryCount += 1; }
          }
          // 3) 候选未建档高频词：出现 ≥3 次的 2-4 字纯中文词，不在档案、不在常用词表
          const COMMON = new Set(['一个', '什么', '没有', '自己', '他们', '她们', '这个', '那个', '已经', '还是', '就是', '不是', '一下', '起来', '过来', '出来', '时候', '现在', '知道', '觉得', '这样', '那样', '这里', '那里', '有些', '一点', '这么', '那么', '如果', '但是', '而且', '所以', '因为', '虽然', '可是', '只是', '或者', '以及', '对于', '关于', '通过', '开始', '最后', '然后', '不过', '而是', '像是', '仿佛', '似乎', '顿时', '瞬间', '立刻', '马上', '继续', '直接', '突然', '忽然', '十分', '非常', '极其', '特别', '尤其', '真的', '确实', '当然', '原来', '其实', '终于', '竟然', '居然', '几乎', '差点', '再次', '重新', '不停', '不断', '一样', '一般', '一些', '各种', '所有', '全部', '整个', '任何', '其他', '别人', '大家', '我们', '你们', '它们', '对方', '两人', '三个', '几个', '多少', '今天', '明天', '昨天', '刚才', '刚刚', '正在', '曾经', '只见', '一声', '一句', '一眼', '一步', '一边', '一头', '一起', '一种', '一片', '一道', '一双', '手中', '身上', '脸上', '眼中', '口中', '心里', '身旁', '身边', '头顶', '面前', '身后', '前方', '后方', '上方', '下方', '中间', '对面', '旁边', '周围', '四周', '附近', '左右', '东西', '上下', '前后', '大小', '长短', '高低', '快慢', '早晚']);
          const counts = new Map();
          for (let len = 2; len <= 4; len += 1) {
            for (let i = 0; i + len <= text.length; i += 1) {
              const s = text.slice(i, i + len);
              if (!/^[\u4e00-\u9fff]{2,4}$/.test(s)) continue;
              counts.set(s, (counts.get(s) || 0) + 1);
            }
          }
          const isKnown = (s) => {
            if (COMMON.has(s)) return true;
            for (const t of registry) { if (t.includes(s) || s.includes(t)) return true; }
            return false;
          };
          unknown = [...counts.entries()]
            .filter(([s, n]) => n >= 3 && !isKnown(s) && !COMMON.has(s.slice(0, 2)) && !COMMON.has(s.slice(-2)))
            .sort((a, b) => b[1] - a[1]);
          // 去掉被更长候选包含的短候选
          unknown = unknown.filter(([s, n]) => !unknown.some(([s2, n2]) => s2 !== s && s2.includes(s) && n2 >= n));
          unknown = unknown.slice(0, 12);
        } else {
          lines.push('（文件系统服务不可用，仅输出风格检查；名词核对需要工程文件。）');
        }
        // 4) 章节序号连续性
        if (fc && args && args.chapter_number) {
          const proj2 = openProject(fc.fs, fc.root, fc.policy);
          const latest = await proj2.latestChapter(undefined);
          if (latest) {
            const latestNum = parseInt((latest.match(/^第(\d+)章/) || [])[1], 10);
            const cur = args.chapter_number;
            if (cur > latestNum + 1) lines.push(`- 章节序号跳跃：工程里最新是第 ${latestNum} 章，你要核对的是第 ${cur} 章。确认中间的章节是否漏存。`);
          }
        }
        // 5) 汇总输出
        lines.push(`【名词档案覆盖】共 ${registryCount} 个已建档名词出现在本章${covered.length ? '：' + covered.slice(0, 15).join('、') : '（正文中没有出现任何已建档名词——确认是否动笔前没查档案）'}。`);
        if (unknown.length) {
          lines.push('');
          lines.push('【候选新设定 · 未建档高频词】以下词在本章反复出现，但不在任何工程档案里。逐个确认：若确属新设定/新角色/新物品，先补进设定集或人物卡再定稿；若只是普通用词，忽略即可：');
          for (const [s, n] of unknown) lines.push(`- "${s}"×${n}`);
        } else {
          lines.push('【候选新设定】未发现未建档的高频词。');
        }
        return lines.join('\n');
      },
    });

    // ---------------- 3. 写前材料组装 ----------------
    // 读工程文件、按结构返回“写前材料”：上一章结尾/最近归档/出场人物卡/活跃
    // 伏笔/时间线/文风卡/大纲设定——全部原文材料，浓缩与取舍由 Agent 完成。
    tool({
      name: 'novel_briefing',
      description: '写前材料组装：从作品工程读取全部相关材料——前 10 章结尾（必要时可扩到 20 章）、上一章结尾原文、最近归档、出场人物卡（按本章计划中人名自动匹配）、活跃伏笔清单、时间线、文风卡、大纲与设定集——以结构化原文返回，并列出材料覆盖情况。零模型调用；材料取舍由你判断。每章动笔前必调，长篇一致性靠它兜底。',
      timeoutMs: 60000,
      parameters: {
        chapter_number: { type: 'integer', description: '准备写的章节序号（用于定位之前的章节；不填则取最新一章之后）' },
        focus: { type: 'string', description: '本章计划/要写什么（可选；提到的人名会自动匹配读取对应人物卡）' },
        recent_chapters: { type: 'integer', description: '参考之前的章数，默认 10，最多 20。剧情涉及范围大（跨卷、回收早期伏笔、久未出场角色回归、多线汇合）时传 20' },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const proj = openProject(fc.fs, fc.root, fc.policy);
        const parts = [];
        const autoParts = [];
        const found = [];
        const missing = [];
        const collect = async (dir, label, maxFiles, cap) => {
          const names = await proj.listMd(dir);
          if (!names.length) { missing.push(label); return; }
          let added = 0;
          for (const name of names.slice(0, maxFiles)) {
            const text = await proj.readMaybe(`${dir}/${name}`, cap);
            if (text && text.trim()) { parts.push(`【${label} · ${name.replace(/\.md$/, '')}】\n${text}`); added += 1; }
          }
          if (added) found.push(label); else missing.push(label);
        };
        await collect('大纲', '大纲', 4, 2500);
        await collect('设定集', '设定', 6, 2000);
        // 出场人物卡：focus/材料文本中出现的人名自动匹配
        const focusText = (args && typeof args.focus === 'string' ? args.focus : '') || '';
        const cards = await proj.listMd('人物卡');
        if (!cards.length) missing.push('人物卡');
        else {
          const matched = [];
          for (const c of cards.slice(0, 40)) {
            const cname = c.replace(/\.md$/, '');
            if (cname === '_索引') continue;
            if (focusText.includes(cname)) matched.push(cname);
          }
          for (const cname of (matched.length ? matched : cards.filter((c) => c !== '_索引.md')).slice(0, 8)) {
            const text = await proj.readMaybe(`人物卡/${cname}`, 2000);
            if (text && text.trim()) parts.push(`【人物卡 · ${cname.replace(/\.md$/, '')}】\n${text}`);
          }
          if (matched.length) autoParts.push(`人物卡按名匹配×${matched.length}（${matched.join('、')}）`);
          found.push('人物卡');
        }
        const foreshadow = await proj.readMaybe('伏笔清单.md', 3000);
        if (foreshadow && foreshadow.trim()) { parts.push(`【伏笔清单】\n${foreshadow}`); found.push('伏笔清单'); } else missing.push('伏笔清单');
        const timeline = await proj.readMaybe('时间线.md', 2000);
        if (timeline && timeline.trim()) { parts.push(`【时间线】\n${timeline}`); found.push('时间线'); } else missing.push('时间线');
        const archives = await proj.listMd('归档');
        if (archives.length) {
          const latest = await proj.readMaybe(`归档/${archives[archives.length - 1]}`, 2000);
          if (latest && latest.trim()) { parts.push(`【最近归档 · ${archives[archives.length - 1].replace(/\.md$/, '')}】\n${latest}`); found.push('最近归档'); }
        } else missing.push('最近归档');
        const prev = await proj.chapterTail(args && args.chapter_number, 1200);
        if (prev) {
          parts.push(`【上一章结尾 · ${prev.name.replace(/\.md$/, '')}】（下一章开头必须承接：场景、时间、情绪都要接上）\n${prev.tail}`);
          found.push('上一章结尾');
        } else missing.push('上一章结尾');
        // 前文多章参考：默认前 10 章（必要时 20 章）；上一章已单独给出更完整的结尾，此处不再重复
        const rc = args && args.recent_chapters ? Math.max(1, Math.min(20, args.recent_chapters)) : 10;
        const recent = await proj.recentChapterTails(args && args.chapter_number, rc, 500);
        const earlier = recent.length > 1 ? recent.slice(0, -1) : recent;
        if (earlier.length) {
          const blocks = earlier.map((c) => `—— 第${String(c.num).padStart(3, '0')}章 ${c.name.replace(/\.md$/, '')} 结尾 ——\n${c.tail}`);
          parts.push(`【前文参考 · 之前 ${earlier.length} 章结尾】（以下人物状态、称谓、伏笔与既定事实必须保持连续，不得另编）\n${blocks.join('\n\n')}`);
          found.push(`前文 ${earlier.length} 章结尾`);
        }
        const styleCard = await proj.readMaybe('文风卡.md', 2500);
        if (styleCard && styleCard.trim()) { parts.push(`【文风卡】（写作时语言习惯向它对齐）\n${styleCard}`); found.push('文风卡'); } else missing.push('文风卡');
        if (!parts.length) {
          throw new Error('工作区没有找到作品工程（大纲/设定集/人物卡/伏笔清单/正文）。先用 novel_project 初始化工程并保存内容。');
        }
        const cover = `【材料覆盖】已读取：${found.join('、')}。${missing.length ? `缺失：${missing.join('、')}——缺失部分如本章需要，先用文件工具查看相关文件或补建档案，不要凭空编写。` : '材料齐全。'}`;
        return `${cover}\n\n${parts.join('\n\n')}`;
      },
    });

    // ---------------- 3. 章后归档落盘 ----------------
    // Agent 按格式提取三段更新（伏笔表/时间线行/归档记录），工具只负责原子写入：
    // 伏笔清单.md 整表覆盖、时间线.md 行追加、归档/第NNN章-*.md 落盘。
    tool({
      name: 'novel_archive',
      description: '章后归档落盘：你先按《novel-project》的归档格式从本章正文提取三段更新——①更新后的完整伏笔清单表 ②本章新增时间线行 ③归档记录（摘要/人物状态变化/新增设定/遗留问题）——本工具把它们原子写入工程（伏笔清单.md 覆盖、时间线.md 追加、归档/第NNN章-*.md 落盘）。零模型调用：提取由你完成，落盘由工具完成。人物状态变化还需你同步回填人物卡文件。',
      timeoutMs: 60000,
      parameters: {
        chapter_number: { type: 'integer', description: '章节序号', required: true },
        chapter_title: { type: 'string', description: '章节标题（可选）' },
        foreshadow_table: { type: 'string', description: '更新后的完整伏笔清单 Markdown 表格（表头：| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |；新伏笔追加、推进/回收的更新状态、无变化的行原样保留）' },
        timeline_rows: { type: 'string', description: '本章新增时间线行（每行一条：| 时间 | 事件 | 参与人物 | 影响/后续 |；无新增可省略）' },
        archive_report: { type: 'string', description: '归档记录：①本章摘要（150 字内）②人物状态变化（逐条“人物：变化”）③新增设定要点 ④遗留问题', required: true },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const num = args && args.chapter_number ? args.chapter_number : 0;
        if (!num) throw new Error('缺少章节序号（chapter_number）');
        const report = args && typeof args.archive_report === 'string' && args.archive_report.trim() ? args.archive_report.trim() : '';
        const table = args && typeof args.foreshadow_table === 'string' && args.foreshadow_table.trim() ? args.foreshadow_table.trim() : '';
        const rows = args && typeof args.timeline_rows === 'string' && args.timeline_rows.trim() ? args.timeline_rows.trim() : '';
        if (!report && !table && !rows) throw new Error('三段更新全部为空：至少提供 archive_report');
        // 格式校验（schema 门禁）：表格式不对就拒收，防止坏数据进工程
        if (table) {
          const firstLine = table.split('\n').map((l) => l.trim()).find((l) => l) || '';
          if (!firstLine.startsWith('|') || !firstLine.includes('伏笔')) {
            throw new Error('foreshadow_table 格式不合格：第一行应是 Markdown 表头且包含「伏笔」，例如 | 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |。请修正后重试（工程未被写入）。');
          }
        }
        if (rows && rows !== '无') {
          const bad = rows.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('|'));
          if (bad.length) {
            throw new Error(`timeline_rows 中有 ${bad.length} 行不是合法的表格行（应以 | 开头）：${bad.slice(0, 2).join(' / ')}。请修正后重试（工程未被写入）。`);
          }
        }
        const proj = openProject(fc.fs, fc.root, fc.policy);
        const ct = args && args.chapter_title ? args.chapter_title : '';
        const out = [];
        if (table) {
          await proj.write('伏笔清单.md', `# 伏笔清单\n\n${table}\n`);
          out.push('伏笔清单.md：已覆盖更新');
        }
        if (rows && rows !== '无') {
          const existing = await proj.readMaybe('时间线.md');
          const header = '# 时间线\n\n| 时间 | 事件 | 参与人物 | 影响/后续 |\n| --- | --- | --- | --- |\n';
          const base = existing && existing.trim() ? `${existing.trimEnd()}\n` : header;
          await proj.write('时间线.md', `${base}${rows}\n`);
          out.push('时间线.md：已追加本章事件');
        }
        const archiveFile = `归档/第${String(num).padStart(3, '0')}章${ct ? '-' + safeName(ct) : ''}-归档.md`;
        await proj.write(archiveFile, `# 第${num}章 归档${ct ? ' · ' + ct : ''}\n\n${report || '（无归档记录）'}\n`);
        out.push(`归档记录：${archiveFile}`);
        return compose([
          `第${num}章归档落盘完成：`,
          ...out.map((l) => `- ${l}`),
          '提醒：人物状态变化若影响人物卡，用文件工具同步回填 人物卡/ 对应文件（工具不代写）。',
        ]);
      },
    });

    // ---------------- 4. 作品工程 ----------------
    // ---- 工程模板读取（templates/ 是数据目录，Agent 直接拉模板而无需从零搭建）----
    // 模板查找顺序：<工作区>/templates/<id>（用户自定义，可覆盖）→ <包安装位>/templates/<id>。
    // 模板目录结构：<id>/template.yml（清单）+ <id>/files/**（文件树，内容支持 {{title}} 变量）。
    function parseTemplateYml(text) {
      const meta = {};
      for (const raw of String(text).split('\n')) {
        const m = raw.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        meta[m[1]] = v;
      }
      return meta;
    }
    function readTemplateDirAt(base, id) {
      const dir = pathMod.join(base, id);
      let metaRaw;
      try { metaRaw = fsMod.readFileSync(pathMod.join(dir, 'template.yml'), 'utf8'); } catch { return null; }
      const files = new Map();
      const filesDir = pathMod.join(dir, 'files');
      const walk = (sub) => {
        for (const e of fsMod.readdirSync(sub ? pathMod.join(filesDir, sub) : filesDir, { withFileTypes: true })) {
          const rel = sub ? `${sub}/${e.name}` : e.name;
          if (e.isDirectory()) walk(rel);
          else if (e.isFile() && !e.name.startsWith('.')) files.set(rel, fsMod.readFileSync(pathMod.join(filesDir, rel), 'utf8'));
        }
      };
      try { walk(''); } catch (err) { return null; }
      if (!files.size) return null;
      return { meta: parseTemplateYml(metaRaw), id, files, source: base };
    }
    function loadTemplate(id, root) {
      const bases = [pathMod.resolve(root, 'templates'), pathMod.join(pkgRoot, 'templates')];
      for (const base of bases) {
        const t = readTemplateDirAt(base, String(id));
        if (t) return t;
      }
      return null;
    }
    function listTemplates(root) {
      const out = [];
      const seen = new Set();
      const bases = [[pathMod.resolve(root, 'templates'), '工作区'], [pathMod.join(pkgRoot, 'templates'), '内置']];
      for (const [base, label] of bases) {
        let entries;
        try { entries = fsMod.readdirSync(base, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith('.') || seen.has(e.name)) continue;
          const t = readTemplateDirAt(base, e.name);
          if (!t) continue;
          seen.add(e.name);
          out.push({ ...t, label });
        }
      }
      return out;
    }
    const applyVars = (text, vars) => String(text).replace(/\{\{(\w+)\}\}/g, (all, k) => (vars[k] !== undefined ? vars[k] : all));
    // WebUI 资产安装（初始化 webui 工程 / novel_webui 安装服务 共用）：幂等，可作升级
    const webuiVersion = () => {
      try {
        const src = fsMod.readFileSync(pathMod.join(pkgRoot, 'webui', 'server.mjs'), 'utf8');
        return (src.match(WEBUI_VERSION_RE) || [])[1] || '未知';
      } catch { return null; }
    };
    async function installWebuiAssets(fs, root, policy) {
      const srcDir = pathMod.join(pkgRoot, 'webui');
      const version = webuiVersion();
      const installed = [];
      for (const name of WEBUI_ASSETS) {
        let content;
        try { content = fsMod.readFileSync(pathMod.join(srcDir, name), 'utf8'); } catch { continue; }
        const target = await fs.resolve(`.webui/${name}`, { cwd: root });
        await fs.writeText(target, content, undefined, undefined, policy);
        installed.push(name);
      }
      // 可选配置：仅首次创建（保留用户已改的配置）。存在性用「读一把」判断，
      // 不依赖 fs.resolve 对缺失文件的行为。
      let existingCfg = null;
      try { existingCfg = await fs.readText(await fs.resolve('.webui/config.json', { cwd: root })); } catch { existingCfg = null; }
      if (existingCfg === null) {
        const target = await fs.resolve('.webui/config.json', { cwd: root });
        await fs.writeText(target, `${JSON.stringify({
          $comment: '作品工程 WebUI 可选配置（不填的键用默认值）：port 端口（默认 4311，被占用自动顺延）；host 监听地址（默认 127.0.0.1，勿随意改成 0.0.0.0）；token 访问令牌（绑定非本机地址时必填）。',
          port: 0,
          host: '127.0.0.1',
          token: '',
        }, null, 2)}\n`, undefined, undefined, policy);
        installed.push('config.json');
      }
      return { installed, version };
    }

    tool({
      name: 'novel_project',
      description: '作品工程：把小说组织成工程目录（正文/大纲/设定集/人物卡/归档/伏笔清单/时间线/文风卡/剧情线）。创建工程时先选工程规范——obsidian（默认，纯 Markdown，Obsidian 直接打开）或 webui（同样以 Markdown 为唯一事实源，额外安装轻量 WebUI 服务，可网页管理人物卡/设定卡/大纲剧情线，用 novel_webui 启动）——再选工程模板（查询模板列出可直接拉取的骨架，不必从零搭建）。还负责保存章节（内置质量门禁）、统计进度、整理索引。纯文件操作，零模型调用。',
      timeoutMs: 120000,
      parameters: {
        action: { type: 'string', enum: ['初始化工程', '查询模板', '保存章节', '统计进度', '整理索引'], description: '操作类型', required: true },
        title: { type: 'string', description: '作品名（初始化/整理索引时用）' },
        规范: { type: 'string', enum: ['obsidian', 'webui'], description: '工程规范（初始化工程时用，默认 obsidian）：obsidian=纯 Markdown 工程；webui=Markdown 之上叠加 WebUI 服务（.webui/ 目录，Obsidian 不显示隐藏目录，两种规范可随时混用）' },
        template: { type: 'string', description: '工程模板 id（初始化工程时用，可选）。先用 查询模板 列出可用模板；不传则拉取内置空白模板（blank），模板目录缺失时回退到内置骨架' },
        chapter_number: { type: 'integer', description: '章节序号（保存章节时用）' },
        chapter_title: { type: 'string', description: '章节标题（保存章节时用）' },
        content: { type: 'string', description: '章节正文（保存章节时用，纯文本）' },
        force: { type: 'boolean', description: '保存章节时的门禁豁免：正文存在硬违规时默认拒绝落盘；确认必须带伤保存才传 true' },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const { fs, root, policy } = fc;
        const proj = openProject(fs, root, policy);
        const write = proj.write;
        const action = args && typeof args.action === 'string' ? args.action : '';
        const out = [];
        if (action === '查询模板') {
          const list = listTemplates(root);
          if (!list.length) {
            return `没有找到任何工程模板（查找位置：${pathMod.resolve(root, 'templates')} 与 ${pathMod.join(pkgRoot, 'templates')}）。\n仍可直接 初始化工程：不传 template 时会使用内置空白骨架。`;
          }
          const lines = ['可用工程模板（初始化工程时把模板 id 传给 template 参数即可整套拉取；规范 obsidian/webui 与模板可任意组合）：', ''];
          for (const t of list) {
            lines.push(`- ${t.id}（${t.label}）——${t.meta.name || ''}：${t.meta.description || ''}`);
          }
          lines.push('');
          lines.push('用法示例：novel_project action=初始化工程 title=书名 template=hotblood-xuanhuan 规范=webui');
          return lines.join('\n');
        }
        if (action === '初始化工程') {
          const t = args && args.title ? args.title : '未命名作品';
          const spec = args && args.规范 === 'webui' ? 'webui' : 'obsidian';
          const vars = { title: t, date: new Date().toISOString().slice(0, 10) };
          // 组装文件树：指定模板 → 内置 blank 模板 → 内置骨架兜底
          let files = null;
          let tplLabel = '';
          if (args && args.template) {
            const tpl = loadTemplate(args.template, root);
            if (!tpl) {
              const known = listTemplates(root).map((x) => x.id).join('、') || '（无）';
              throw new Error(`找不到工程模板「${args.template}」。可用模板：${known}。先用 action=查询模板 查看详情。`);
            }
            files = tpl.files;
            tplLabel = `${tpl.id}（${tpl.label}）`;
          } else {
            const blank = loadTemplate('blank', root);
            if (blank) { files = blank.files; tplLabel = 'blank（内置空白）'; }
          }
          if (files) {
            for (const [rel, content] of files) await write(rel, applyVars(content, vars));
          } else {
            // 内置骨架兜底（templates/ 随包分发；此分支仅在安装不完整时触达）
            await write('README.md', `# ${t}\n\n> 作品索引（由 novel_project 维护，双链导航）\n\n- 简介：\n- 状态：\n\n## 快速导航\n\n- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]] · [[大纲/剧情线|剧情线]]\n- [[人物卡/_索引|人物卡]] · [[设定集/_索引|设定集]]\n- 章节：见下方（整理索引后自动生成）\n`);
            await write('伏笔清单.md', `# 伏笔清单\n\n| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |\n| --- | --- | --- | --- | --- |\n`);
            await write('时间线.md', `# 时间线\n\n| 时间 | 事件 | 参与人物 | 影响/后续 |\n| --- | --- | --- | --- |\n`);
            await write('大纲/总纲.md', '# 总纲\n\n## 核心设定\n\n## 主线\n\n## 分卷规划\n');
            await write('设定集/_索引.md', '# 设定集索引\n\n> 每类设定一个文件；文件之间与人物卡用双链互相关联（如 [[主角]]、[[设定集/力量体系|力量体系]]）\n\n');
            await write('设定集/世界观.md', '# 世界观\n\n（核心世界观设定；相关链接：[[设定集/力量体系]]、[[设定集/地理]]）\n');
            await write('设定集/力量体系.md', '# 力量体系\n\n（等级/功法/战力规则与代价）\n');
            await write('设定集/地理.md', '# 地理\n\n（大陆/国家/城市/重要地点）\n');
            await write('设定集/势力.md', '# 势力\n\n（宗门/家族/组织/阵营）\n');
            await write('人物卡/_索引.md', '# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]），设定关联用 [[设定集/xxx]]\n\n');
            await write('归档/说明.md', '# 归档\n\n每章归档一个文件：第NNN章-归档.md（由 novel_archive 落盘）\n');
            await write('正文/说明.md', '# 正文\n\n每章一个文件：`第NNN章-标题.md`\n');
            await write('文风卡.md', '# 文风卡\n\n> 按《novel-project》的文风卡格式，从基准章节生成后保存到本文件；写正文前必读对齐。重新生成直接覆盖。\n');
          }
          // 剧情线：模板未提供时补标准空表（webui 页面与 Obsidian 都按表读写）
          if (!files || !files.has('大纲/剧情线.md')) {
            await write('大纲/剧情线.md', `# ${t} · 剧情线\n\n> 网页端与 Obsidian 都按表格读写：线名/类型（主线|支线|感情线|暗线）/状态（铺设中|推进中|已收束）/起点/终点/关键节点\n\n| 线名 | 类型 | 状态 | 起点 | 终点 | 关键节点 |\n| --- | --- | --- | --- | --- | --- |\n`);
          }
          out.push(`已初始化工程：规范=${spec}${tplLabel ? ` · 模板=${tplLabel}` : ''}（作品名「${t}」）`);
          out.push(`目录：README、伏笔清单、时间线、文风卡、大纲/（总纲+剧情线）、设定集/（分类+_索引）、人物卡/_索引、归档/、正文/`);
          if (spec === 'webui') {
            const { installed, version } = await installWebuiAssets(fs, root, policy);
            out.push(`WebUI 资产已安装到 .webui/（${installed.join('、')}，服务 v${version || '?'}）；用 novel_webui action=启动服务 拉起后把地址给用户。`);
          } else {
            out.push('提示：之后想改用网页管理，novel_webui action=安装服务 即可原地升级为 webui 规范（md 文件不动）。');
          }
          out.push('下一步（由你完成）：按《novel-project》与所选模板里的指引填充总纲、人物卡、设定集；有文风基准章节后生成文风卡。');
        } else if (action === '保存章节') {
          const num = args && args.chapter_number ? args.chapter_number : 1;
          const body = args && typeof args.content === 'string' && args.content.trim() ? args.content : '';
          if (!body) throw new Error('章节正文为空，请传入 content');
          // 保存门禁（pre-commit hook）：硬违规未清零的正文不落盘
          const gate = lintText(body);
          if (gate.hardCount > 0 && !(args && args.force === true)) {
            return `【保存被门禁拦截】正文存在 ${gate.hardCount} 项硬违规，未写入工程。请按下方清单逐句修复后重新保存；确属必须带伤保存的场景，重新调用并传 force: true。\n\n${gate.report}`;
          }
          const file = await saveChapterFile(fs, root, policy, num, args && args.chapter_title ? args.chapter_title : '', body);
          const gateLine = gate.hardCount === 0
            ? `门禁通过：硬违规清零（软提示 ${gate.softCount} 项${gate.softCount ? '，多为禁词/频次，可按需处理' : ''}）。`
            : '门禁豁免（force: true）：硬违规仍存在，已带伤写入。';
          out.push(`已保存章节：${file}`);
          out.push(gateLine);
        } else if (action === '统计进度') {
          const names = await proj.listMd('正文');
          const rows = [];
          let total = 0;
          for (const name of names) {
            const text = await proj.readMaybe(`正文/${name}`);
            const count = text ? text.replace(/\s+/g, '').length : 0;
            total += count;
            rows.push(`| ${name.replace(/\.md$/, '')} | ${count} |`);
          }
          const avg = names.length ? Math.round(total / names.length) : 0;
          out.push([
            `## 进度统计`,
            ``,
            `| 章节 | 字数 |`,
            `| --- | --- |`,
            ...rows,
            ``,
            `章节数：${names.length}；总字数：${total}；平均每章：${avg}`,
          ].join('\n'));
        } else if (action === '整理索引') {
          const t = args && args.title ? args.title : '未命名作品';
          const chapters = await proj.listMd('正文');
          const chars = await proj.listMd('人物卡');
          const sets = await proj.listMd('设定集');
          const arcs = await proj.listMd('归档');
          const skip = (f) => f !== '_索引.md' && f !== '说明.md';
          const chapterLinks = chapters.map((c) => `- [[${c.replace(/\.md$/, '')}]]`).join('\n');
          const charLinks = chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n');
          const setLinks = sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n');
          const arcLinks = arcs.filter(skip).map((a) => `- [[归档/${a.replace(/\.md$/, '')}|${a.replace(/\.md$/, '')}]]`).join('\n');
          await write('README.md', `# ${t}\n\n> 作品索引（由 novel_project 维护）\n\n- 简介：\n- 状态：\n- 章节数：${chapters.length}\n\n## 章节\n\n${chapterLinks || '（暂无）'}\n\n## 人物\n\n${charLinks || '（暂无）'}\n\n## 设定\n\n${setLinks || '（暂无）'}\n\n## 归档\n\n${arcLinks || '（暂无）'}\n\n## 追踪\n\n- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]]\n`);
          if (chars.filter(skip).length > 0) {
            await write('人物卡/_索引.md', `# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]）\n\n${chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n')}\n`);
          }
          if (sets.filter(skip).length > 0) {
            await write('设定集/_索引.md', `# 设定集索引\n\n> 每类设定一个文件；与人物卡用双链互相关联\n\n${sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n')}\n`);
          }
          out.push(`已整理索引：README.md（${chapters.length} 章、${chars.filter(skip).length} 人物、${sets.filter(skip).length} 设定，全部双链）`);
        } else {
          throw new Error(`未知操作：${action}`);
        }
        return out.join('\n');
      },
    });

    // ---------------- 4.5 WebUI 服务管理（webui 工程规范的服务层） ----------------
    // 服务本体是零依赖 Node 脚本（webui/server.mjs），从这里以分离进程拉起，
    // 不依赖 Agent 进程存活；运行状态写在 <根>/.webui/state.json。
    const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms); });
    const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    async function probeWebui(port, host) {
      const req = await import('node:http').then((h) => h.request);
      return new Promise((resolve) => {
        const r = req({ host: host === '0.0.0.0' ? '127.0.0.1' : host, port, path: '/api/state', timeout: 900 }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        r.on('error', () => resolve(false));
        r.on('timeout', () => { r.destroy(); resolve(false); });
        r.end();
      });
    }
    async function readWebuiState(root) {
      try { return JSON.parse(fsMod.readFileSync(pathMod.join(root, '.webui', 'state.json'), 'utf8')); } catch { return null; }
    }

    tool({
      name: 'novel_webui',
      description: '作品工程 WebUI 服务管理：把轻量网页管理端（零依赖单文件服务）安装进工程 .webui/ 并以后台进程启动，浏览器打开即可管理人物卡、设定卡、大纲与剧情线、章节、伏笔与时间线，并用 AI 味检查、全文搜索、旧稿分章、字数统计等工具。范围=工程 只管理当前作品；范围=工作区 把当前目录当作多工程工作区，自动发现其下全部作品工程、一个页面集中管理（适合把服务架在所有作品工程的公共父目录之外/之上）。md 文件始终是唯一事实源——网页、Obsidian、文件工具编辑的是同一批文件，随时混用。默认只监听 127.0.0.1，不对局域网开放。零模型调用。',
      timeoutMs: 60000,
      parameters: {
        action: { type: 'string', enum: ['安装服务', '启动服务', '停止服务', '服务状态'], description: '操作类型', required: true },
        范围: { type: 'string', enum: ['工程', '工作区'], description: '启动服务时用：工程=只管理当前作品（默认，工程内无服务副本时自动用包内副本）；工作区=当前目录为多工程工作区（用包内副本，服务状态存于 <工作区>/.webui/）' },
        port: { type: 'integer', description: '服务端口（默认 4311，被占用自动顺延；也可在 .webui/config.json 里配置）' },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const { fs, root, policy } = fc;
        const action = args && typeof args.action === 'string' ? args.action : '';
        const scope = args && args.范围 === '工作区' ? '工作区' : '工程';
        if (action === '安装服务') {
          const { installed, version } = await installWebuiAssets(fs, root, policy);
          return `WebUI 资产已安装/升级到 ${root} 的 .webui/（${installed.join('、')}，服务 v${version || '?'}）。之后可直接在该目录运行 node .webui/server.mjs --project . 或由本工具启动服务。已有 md 文件一律未动。`;
        }
        if (action === '启动服务') {
          const stateFile = pathMod.join(root, '.webui', 'state.json');
          let st = await readWebuiState(root);
          if (st && st.pid && pidAlive(st.pid) && await probeWebui(st.port, st.host || '127.0.0.1')) {
            return `服务已在运行：${st.url}（模式 ${st.mode}，v${st.version}，pid ${st.pid}）。无需重复启动；需要重启先 停止服务。`;
          }
          const srcDir = pathMod.join(root, '.webui');
          const localServer = pathMod.join(srcDir, 'server.mjs');
          const serverSrc = fsMod.existsSync(localServer) ? localServer : pathMod.join(pkgRoot, 'webui', 'server.mjs');
          if (!fsMod.existsSync(serverSrc)) throw new Error('找不到 webui/server.mjs（工程内与预设安装位都没有）。先 安装服务，或重装本预设。');
          const argv = [serverSrc, scope === '工作区' ? '--workspace' : '--project', root];
          if (args && args.port) argv.push('--port', String(args.port));
          fsMod.mkdirSync(srcDir, { recursive: true });
          const logPath = pathMod.join(srcDir, 'server.log');
          const out = fsMod.openSync(logPath, 'a');
          let child;
          try {
            child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', out, out], cwd: root, windowsHide: true });
          } finally {
            fsMod.closeSync(out);
          }
          child.unref();
          // 等待就绪：服务监听成功后会写 state.json
          let ready = false;
          for (let i = 0; i < 40 && !ready; i += 1) {
            await sleepMs(250);
            st = await readWebuiState(root);
            ready = Boolean(st && st.port && await probeWebui(st.port, st.host || '127.0.0.1'));
          }
          if (!ready) throw new Error(`服务未能在 10 秒内就绪，请查看日志：${logPath}`);
          const lines = [
            `WebUI 服务已启动（${scope}模式，v${st.version}，pid ${st.pid}）。`,
            `地址：${st.url}（把地址给用户，在浏览器打开即可管理${scope === '工作区' ? `工作区下的 ${st.projects ? '' : ''}全部工程` : '本工程'}）`,
            st.tokenSet ? '该服务启用了访问令牌：页面首次打开会提示输入 token（配置在 .webui/config.json）。' : '未启用令牌（仅本机回环监听）。',
            `停止方式：novel_webui action=停止服务；或访问 ${st.url}api/shutdown（POST）。日志：${logPath}`,
            '提醒：md 文件仍是唯一事实源，网页与 Obsidian、文件工具编辑同一批文件；下一步的生成与检查工作照常由你和 novel_* 工具完成。',
          ];
          return lines.join('\n');
        }
        if (action === '停止服务') {
          const st = await readWebuiState(root);
          if (!st || !st.pid) return '没有找到运行记录（.webui/state.json 不存在），服务应当未在运行。';
          try { process.kill(st.pid, 'SIGTERM'); } catch (err) { /* 进程可能已退出 */ }
          let dead = !pidAlive(st.pid);
          for (let i = 0; i < 12 && !dead; i += 1) {
            await sleepMs(250);
            dead = !pidAlive(st.pid);
          }
          if (!dead) {
            try { process.kill(st.pid, 'SIGKILL'); } catch { /* 已退出 */ }
          }
          try { fsMod.rmSync(pathMod.join(root, '.webui', 'state.json'), { force: true }); } catch { /* 尽力清理 */ }
          return `服务已停止（pid ${st.pid}${dead ? '' : '，已强制结束'}，模式 ${st.mode}）。md 工程文件不受影响。`;
        }
        if (action === '服务状态') {
          const st = await readWebuiState(root);
          if (!st) return `未运行。${scope === '工作区' ? '（工作区模式的状态存于 <工作区>/.webui/state.json）' : ''}可 action=启动服务 拉起。`;
          const alive = pidAlive(st.pid) && await probeWebui(st.port, st.host || '127.0.0.1');
          return alive
            ? `运行中：${st.url}（${st.mode}模式，v${st.version}，pid ${st.pid}，自 ${st.startedAt} 起）`
            : `未运行（有残留状态：pid ${st.pid} 已不响应）。可 action=启动服务 重新拉起。`;
        }
        throw new Error(`未知操作：${action}`);
      },
    });

    // ---------------- 5. 旧稿导入（纯代码分章） ----------------
    tool({
      name: 'novel_import',
      description: '旧稿导入：把已有小说存稿接入作品工程——按“第X章”标记分章、逐章落盘到 正文/ 并生成索引。纯代码分章，零模型调用；导入后的大纲/人物卡/设定集逆推由你按《novel-analysis》（拆书）与《novel-project》（建档格式）完成并自行落盘。',
      timeoutMs: 120000,
      parameters: {
        text: { type: 'string', description: '旧稿全文（含“第X章”等章节标记的长文本）', required: true },
        title: { type: 'string', description: '作品名（写入索引，可选）' },
        chapter_number: { type: 'integer', description: '起始章号（默认 1，已有章节续接时改这里）' },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const { fs, root, policy } = fc;
        const text = args && typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('缺少旧稿文本（text）');
        const start = args && args.chapter_number ? args.chapter_number : 1;

        // 1) 分章：以独立的“第X章/回/节 标题”行为界（规则与 WebUI 旧稿分章共享）
        const headingRe = chapterHeadingRe;
        const chapters = [];
        let cur = null;
        for (const raw of text.split('\n')) {
          const line = raw.trim();
          if (headingRe.test(line)) {
            if (cur) chapters.push(cur);
            cur = { title: line, body: [] };
          } else {
            if (!cur) cur = { title: '', body: [] };
            cur.body.push(raw);
          }
        }
        if (cur) chapters.push(cur);
        const real = chapters.filter((c) => c.body.join('\n').trim().length > 0 || c.title);
        if (!real.length) throw new Error('未能识别出任何章节，请确认文本包含“第X章”类章节标记');

        // 2) 逐章落盘（文件名去掉原“第X章”前缀，按新序号重排）
        const saved = [];
        for (let i = 0; i < real.length; i += 1) {
          const body = real[i].body.join('\n').trim();
          if (!body) continue;
          const cleanTitle = real[i].title.replace(/^第[0-9零一二三四五六七八九十百千两]+[章回节]\s*[:：、.\-—]?\s*/, '');
          const file = await saveChapterFile(fs, root, policy, start + saved.length, cleanTitle, body);
          saved.push(file);
        }
        const out = [`已导入 ${saved.length} 章到 正文/（第${start}章起）`];

        if (args && args.title) {
          const listLines = saved.map((f) => '- [[' + f.replace(/^正文\//, '').replace(/\.md$/, '') + ']]').join('\n');
          const readme = '# ' + args.title + '\n\n> 作品索引（由 novel_project 维护；旧稿由 novel_import 导入）\n\n- 章节数：' + saved.length + '\n\n## 章节\n\n' + listLines + '\n';
          const target = await fs.resolve('README.md', { cwd: root });
          await fs.writeText(target, readme, undefined, undefined, policy);
          out.push('已更新索引：README.md');
        }
        out.push('下一步（由你完成）：按《novel-analysis》拆书方法逆推大纲；按《novel-project》建档格式为的出现人物建人物卡、按类别整理设定集；最后 novel_project 整理索引。');
        return out.join('\n');
      },
    });

    // ---------------- 6. 全书体检材料组装 ----------------
    tool({
      name: 'novel_scan_book',
      description: '全书体检材料组装：从作品工程选取章节（最近连续 N 章或首中尾抽样），连同人物卡/设定集/大纲/伏笔清单一起组装返回——跨章一致性分析（人物矛盾/时间线错位/设定冲突/战力崩坏/伏笔遗忘/跨章重复）由你按《novel-analysis》与《novel-continuity》完成。零模型调用。',
      timeoutMs: 60000,
      parameters: {
        scope: { type: 'string', enum: ['最近章节', '全书抽样'], description: '扫描范围，默认最近章节' },
        chapter_count: { type: 'integer', description: '纳入的章数（1-12），默认 5' },
      },
      run: async (args, exec) => {
        const fc = fsContext(exec);
        if (!fc) throw new Error('文件系统服务不可用');
        const proj = openProject(fc.fs, fc.root, fc.policy);

        const names = await proj.listMd('正文');
        const parsed = names
          .map((n) => ({ n, num: parseInt((n.match(/^第(\d+)章/) || [])[1], 10) }))
          .filter((c) => !Number.isNaN(c.num));
        if (!parsed.length) throw new Error('正文/ 下没有可扫描的章节文件，请先保存或导入章节');
        parsed.sort((a, b) => a.num - b.num);
        const count = args && args.chapter_count ? Math.max(1, Math.min(12, args.chapter_count)) : 5;
        const scope = args && args.scope === '全书抽样' ? '全书抽样' : '最近章节';
        let picked;
        if (scope === '全书抽样' && parsed.length > 4) {
          const head = parsed.slice(0, 2);
          const tail = parsed.slice(-Math.max(count - 3, 1));
          const mid = [parsed[Math.floor(parsed.length / 2)]];
          picked = [...head, ...mid, ...tail];
        } else {
          picked = parsed.slice(-count);
        }
        const seen = new Set();
        const chapters = [];
        for (const p of picked) {
          if (seen.has(p.n)) continue;
          seen.add(p.n);
          const t = await proj.readMaybe(`正文/${p.n}`, 9000);
          if (t) chapters.push(`### ${p.n}\n${t}`);
        }

        const readDir = async (dir, cap, maxFiles) => {
          const files = await proj.listMd(dir);
          const parts = [];
          for (const f of files.slice(0, maxFiles)) {
            const t = await proj.readMaybe(`${dir}/${f}`, cap);
            if (t) parts.push(`### ${dir}/${f}\n${t}`);
          }
          return parts.join('\n\n');
        };
        const [chars, sets, outline, foreshadow] = await Promise.all([
          readDir('人物卡', 2500, 6),
          readDir('设定集', 2500, 6),
          readDir('大纲', 2500, 4),
          proj.readMaybe('伏笔清单.md', 2500),
        ]);

        const user = [
          chars ? `【人物卡（工程材料）】\n${chars}` : '【人物卡】（空）',
          sets ? `【设定集（工程材料）】\n${sets}` : '【设定集】（空）',
          outline ? `【大纲（工程材料）】\n${outline}` : '【大纲】（空）',
          foreshadow ? `【伏笔清单】\n${foreshadow}` : '【伏笔清单】（空）',
          `【扫描范围】${scope}（共 ${chapters.length} 章：${[...seen].join('、')}）`,
          `【正文章节】\n${chapters.join('\n\n')}`,
          '',
          '↑ 以上是体检材料。接下来由你按六个维度完成跨章体检（人物一致性/时间线/设定冲突/战力体系/伏笔遗忘/跨章重复），输出：问题清单（位置/类型/严重度/修复建议）+ 跨章重复清单 + 总体结论。',
        ].join('\n\n');
        return user;
      },
    });

    // ---------------- 工作法路由提示段（薄常驻层） ----------------
    // 分层原则：一切模型生成由 Agent 完成（工具零模型调用），方法论住在 skills/
    // 按需加载；常驻层只保留硬流程、路由索引、文风底线与硬纪律。
    // 写法要求：每条规则都是完整句子，不使用词组串、箭头链和未解释的自造术语。
    disposers.push(ctx.systemPrompt.section({
      name: 'novel:methodology',
      order: 50,
      text: `【小说助手工作法】——以下规则任何时候都要遵守。

一、分工：模型生成全部由你完成，工具只做文件操作和检查
- 润色、大纲、细纲、拆书、评阅、对话、场景、采访、合规、起名、文风卡、归档提取，这些创作与分析任务都没有对应的工具。先加载相关的 skill，再按 skill 里的流程亲自完成。
- 八个工具只负责代码能完成的事。novel_lint 检查正文是否违反铁律；novel_check 核对正文里的名词是否都有档案出处；novel_briefing 读取工程文件并组装写前材料；novel_archive 把你提取好的归档内容写入工程；novel_project 管理工程目录（含查询与拉取工程模板）并在保存章节时执行质量门禁；novel_import 把旧稿按章节标记拆分落盘；novel_scan_book 汇总全书体检所需的材料；novel_webui 安装、启动、停止作品工程的网页管理服务。

二、写正文的完整流程（每次亲写正文都走一遍）
第一步，加载《novel-prose-standards》，按它要求的生成时干预来写。具体做法是：动笔前先为每个场景准备至少 3 个具体细节，比如具体数字、有专名的物件、身体化的动作，写作时把它们埋进去；每写三四个正常长度的句子，就接一个不超过 8 字的短句，或者让一句话单独成段；相邻的两段不要用同一种方式开头；全文不使用“仿佛”“似乎”“像是在”这类模糊词，直接写实际发生了什么。超过 2500 字的章节要按场景分段写，每段写之前先回看上一段的结尾。
第二步，写完后把全文交给 novel_lint 检查。检查结果里标记为【必须修】的问题要逐句修复，然后再次运行 novel_lint，直到不再报出硬违规为止。
第三步，把全文交给 novel_check 做名词核对。它会把正文里反复出现、但不在人物卡/设定集/伏笔清单里的词列出来。逐个确认：确实是新设定的，先补进设定集或人物卡再定稿；只是普通用词的，忽略。
第四步，把定稿保存到 正文/第NNN章-标题.md，用 novel_project 的保存章节功能写入。它内置质量门禁：正文还有硬违规时会拒绝落盘，所以不要用文件工具绕过它直写正文目录。
这样做的目标是一开始就写出干净的稿子。去 AI 味重写只用于处理用户粘贴的外来文本和旧稿，不用于你自己的正常创作。

三、每章的标准闭环（长篇连载时，每章按此顺序执行）
1. 运行 novel_briefing，取得前 10 章结尾、上一章结尾、最近归档、出场人物卡、活跃伏笔、时间线和文风卡。这些是工程里的原文材料，如何取舍由你根据本章需要判断。剧情涉及范围大（跨卷、回收早期伏笔、久未出场角色回归、多线汇合）时，给它传 recent_chapters: 20，把参考面扩到前 20 章。
2. 亲自写整章。用户没有特别说明时，一章写 2000 到 4000 字；结尾要收在场景或情节的落点上，不要中途截断，不要把没写完的场景硬切一刀，并尽量在章尾留下钩子。
3. 运行 novel_lint，修复全部硬违规，再复查一次直到清零。
4. 运行 novel_check 做名词核对，确认没有未建档的新设定混进正文。
5. 用 novel_project 的保存章节功能落盘（门禁会做最后把关）。
6. 按《novel-project》里的归档格式，从本章正文提取三部分更新：更新后的伏笔清单表格、本章新增的时间线行、本章的归档记录。把它们交给 novel_archive 写入工程。人物状态有变化的，同时用文件工具回填对应的人物卡文件。
7. 每隔几卷，用 novel_project 整理一次作品索引。
伏笔清单、时间线、人物状态这三样，每章归档时必须全部更新，缺一项就不算完成归档。

四、skill 路由（动笔前先加载对应的 skill，再按它执行）
- 要写、改、润色正文，或者去除正文里的 AI 味：加载 novel-prose-standards，它包含正文铁律和润色、改写、对话、翻译的任务流程。
- 要在写作前确认哪些词不能用，或者要做去 AI 味、审稿：加载 novel-ai-lexicon，它是 AI 味分级特征库，除词库外还覆盖对话标签、段尾总结句这类结构层特征。
- 要在动笔前核对设定、衔接前文、回填归档，或者排查剧情漏洞：加载 novel-continuity。
- 要做总纲、卷纲、细纲、章节规划、情节推演、灵感、书名与简介包装：加载 novel-plotting。
- 要写场景、设计开篇、采访角色、安排人物出场：加载 novel-craft。
- 要分析小说、拆书、评阅稿件、模拟读者团、做合规体检、起名：加载 novel-analysis。
- 要初始化工程、生成文风卡、建人物卡和设定集、按格式归档、整理索引、导入旧稿、使用 Obsidian：加载 novel-project。

五、文风底线（写任何小说文字时都生效；完整规范在 novel-prose-standards 里）
1. 网文不是学术研究。不要出现“综上所述”“由此可见”“值得注意的是”“某种意义上”这类论文用语，不要堆术语，不要做概念分析，不要发议论。你在写故事，不是在写评论。
2. 要通俗易懂。读者用手机快速划屏阅读，每句话要能一眼看懂。不写晦涩的长难句，不绕弯子，不使用需要查资料才能懂的典故。宁可朴素，也不要故作高深。
3. 句式要有变化。同一类句式、同一种开头、同一种节奏，连续使用不要超过两次。长短句要交错，允许一句话单独成段。
4. 不用 AI 高频词。“心中一沉”“瞳孔骤缩”“倒吸凉气”“眼底闪过”“呼吸一滞”“喉结滚动”“缓缓”“微微”“不由得”“瞬间”“刹那”“仿佛”“似乎”“像是”这些词能不用就不用，写了就改掉；“沉默了三秒”这类秒表式计时改成行为计时；“顿了顿”“沉默”“苦笑”是正常词但密度极易失控，一章各不超过一两次。平时答复用户时，也要少用“首先、其次、总之、综上”这种结构腔。
5. 不堆砌辞藻。不写没有信息量的形容词堆砌和抒情排比。每个比喻都要让读者看得更明白或更有感觉，否则就删掉。
6. 引号要规范。对话和一切引语一律用中文弯双引号 ""，引语内嵌套时才用单引号 ''。正文、示例、引用的词语全部如此。直角引号出现在正文里就是硬伤，novel_lint 会拦截它。

六、一致性硬纪律
1. 小说正文用纯文本，不包含 markdown 符号、emoji 和标题；大纲、分析、报告可以用 Markdown。
2. 工程里有 文风卡.md 时，动笔前必读，写出来的文字要向它对齐。novel_briefing 会把它带出来；没有文风卡的长篇，以最近一两章的文字为文风基准。
3. 可以量化的检查交给 novel_lint；你自己的自查只负责机器查不了的部分：视角是否越界、有没有情绪标签、对话是否像说明书。
4. 写人物之前先查人物卡；新设定先写进设定集，再出现在正文里；伏笔必须登记进伏笔清单。称谓、战力、时间线全书保持一致。
5. 设定必须有出处。正文里出现的每一个地名、组织、功法、物品、规则，动笔前都必须能在设定集或已写章节里找到出处。查不到的：要么先补进设定集再写，要么改用已有设定。出场人物同理——必须在人物卡或前文出现过，全新角色要先建人物卡。写完一章后回头对照材料自查一遍：本章有没有用到查无出处的东西，有没有和前文矛盾。
6. 去 AI 味重写只用于外来文本和旧稿。正常创作从落笔就按规范写，不做“先带 AI 味、事后去味”的二道工序。
7. 断更或新会话续写时：先用 novel_briefing 组装材料，或者直接读最近归档、伏笔清单和上一章结尾，找回状态后再动笔。

七、工程规范与模板（建工程时先定这两件事）
1. 工程规范二选一：obsidian（默认）=纯 Markdown 工程，Obsidian 直接打开编辑；webui=同样以 md 文件为唯一事实源，额外安装轻量网页管理服务（.webui/ 隐藏目录），可在浏览器里管理人物卡、设定卡、大纲与剧情线、章节、伏笔时间线，并提供 AI 味检查、全文搜索、旧稿分章等工具。两种规范可随时互转：novel_webui action=安装服务 即原地加装网页层，md 文件一个不动。
2. 工程模板是现成的工程骨架数据。初始化工程前先 action=查询模板 看有哪些可拉取的模板（热血玄幻、悬疑诡秘、甜宠言情等），把模板 id 传给 template 参数即可整套落盘，不必从零逐个建文件；模板与规范可任意组合（template=hotblood-xuanhuan 规范=webui）。用户工作区的 templates/ 目录可放自定义模板，优先于内置模板。
3. 用户想在网页里管理工程、或同时打理多部小说时，用 novel_webui：action=启动服务 范围=工程 管理当前作品；范围=工作区 把当前目录当作多工程工作区，一个页面集中管理其下全部工程。启动后把服务地址告诉用户。md 文件仍是唯一事实源：网页、Obsidian、文件工具编辑的是同一批文件，用户在网页上做的修改你直接读文件即可看到，反之亦然。`,
    }));

    return () => { for (const d of disposers) d(); };
  },
};

function compose(parts) { return parts.filter((p) => p && p.trim()).join('\n\n'); }
