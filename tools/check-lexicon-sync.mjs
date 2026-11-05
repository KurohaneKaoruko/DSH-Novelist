#!/usr/bin/env node
// 词库同步校验：skill 词库（novel-ai-lexicon 一级区）↔ lint 禁用词库（BANNED）
// -----------------------------------------------------------------------------
// 两份词库曾两次人工漂移（漏收/漏改）。本脚本从 SKILL.md 一级区机械提取词条，
// 与 plugins/lint.mjs 的 BANNED 数组做双向 diff，任何方向的不一致都非零退出：
//   · skill 有、lint 无 —— 漏收：正文里的该表达不会被 novel_lint 拦截；
//   · lint 有、skill 无且不在豁免表 —— 漏记：禁用词没有词条出处，改词库时容易漏改。
// 零依赖（纯 node 标准库），不 import lint.mjs——直接读源码，词库语法坏了也能查出。
//
// 跑法：node check-lexicon-sync.mjs    （已挂进 npm test 首位，CI verify 工作流覆盖）
//
// 覆盖判定语义（与 lint 的子串检测一致）：
//   · skill 词条 e 被覆盖 = BANNED 中存在 b 使 b === e.raw，或存在片段 p（≥2 字）
//     被 b 覆盖（b === p 或 b 是 p 的子串——lint 检测 b 在正文中的出现，
//     b 更短则任何含 p 的正文必含 b，必被拦）；单字词条（拟声「轰」）只走 raw 精确匹配；
//   · 含省略号「……」的模板词条按省略号切成固定片段，任一片段被覆盖即算
//     （如「带着不容置疑的……」由「不容置疑」覆盖）；
//   · 反向：BANNED 词条 b 有出处 = 存在 skill 词条（或模板片段）包含 b；
//     确实不出自一级区的 b 登记在 BANNED_OUTSIDE 豁免表并注明来源。
//
// 二级区为何不做机械校验（2026-11 人工比对后的结论）：
//   1. 无同构词库——二级区语义是「限频」不是「禁用」，lint 侧没有对应 BANNED 的单一数组；
//      同一小节的词分属 QUANTIFIERS（全砍）/ ADVERBS（≤2）/ SOFT_FREQ（≤3）/「瞬间词」正则
//      （合计 ≤2）/ 比喻引导词频次等多张执行表，SKILL.md 词条行不携带归属信息，机械 diff
//      需要一张「词 → 执行表」映射表——映射本身成了第二份要同步的词库，得不偿失；
//   2. 词条行不可机械切分——二级区用「／」分隔但混有规则注记（「淡淡（地）」「（写作规范
//      原则上不用；lint 上限频拦截）」「他/她/我知道」等），比一级区多出非词条噪声；
//   3. 全区零缺口的判定当时已由人工完成：逐词对照后补收迂回关联词 11、心理动词 8、
//      高浓度氛围词 19（进 lint 限频/密度表）；「像是/就像」由「像」总频次覆盖、
//      「此刻/这一刻/一时之间」由「瞬间词」正则覆盖，不算漏。
//   因此二级区走「人工比对 + 修正 + 此处留痕」而非机械校验；一级区仍是唯一机械防线。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mdPath = resolve(root, 'skills', 'novel-ai-lexicon', 'SKILL.md');
const lintPath = resolve(root, 'plugins', 'lint.mjs');

// lint 独有词豁免表：词条来源不在 lexicon 一级区（同义变体 / prose-standards / 章末模板）。
// 新增 BANNED 词若不出自一级区，必须在此登记理由，否则校验失败。
const BANNED_OUTSIDE = new Map([
  ['心中了然', '「心下了然」同义变体'],
  ['后背发凉', '「后背一凉／背脊发凉」变体'],
  ['空气瞬间安静', '「空气安静」强化变体'],
  ['世界都安静', '「整个世界安静」变体'],
  ['沉默蔓延', '一级区第 5 节完整句「沉默在两人之间蔓延」的短变体'],
  ['眸子', '「眸光／眸色」同族替换词'],
  ['远没有这么简单', '悬念套话（prose-standards 禁用表）'],
  ['不知过了多久', '时间模糊套话（prose-standards 禁用表）'],
  ['一室寂静', '「落针可闻」同义套话（prose-standards）'],
  ['难以言喻', '不可名状套话（prose-standards 禁用表）'],
  ['无法形容', '同上'],
  ['意味深长', '情绪标签词（prose-standards 禁用表）'],
  ['耐人寻味', '同上'],
  ['复杂的情绪', '情绪标签词（prose-standards 禁用表）'],
  ['眼眸', 'AI 高频替换词（prose-standards 禁用表）'],
  ['薄唇', '同上'],
  ['他不知道的是', '全知视角跳脱套话（prose-standards + 章末模板 TAIL_TEMPLATES）'],
  ['才刚刚开始', '章末模板收尾（TAIL_TEMPLATES 同族）'],
  ['沉默了几秒', '一级区第 9 节秒表计时的同族变体'],
  ['停顿了三秒', '同上'],
  ['几秒钟后', '同上'],
]);

// 从 SKILL.md 提取一级区词条：返回 [{ raw, parts }]
//   raw = 去掉「（…）」注解后的完整词条；parts = 按省略号切的固定片段（模板词条）。
function extractLevel1Entries(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^## 一级：/.test(l));
  const end = lines.findIndex((l) => /^## 二级：/.test(l));
  if (start === -1 || end === -1 || start >= end) {
    throw new Error('SKILL.md 中找不到「## 一级：」「## 二级：」一级区标题');
  }
  const entries = [];
  const seen = new Map();
  for (const line of lines.slice(start + 1, end)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('**改法**') || t.startsWith('**规则**')) continue;
    for (let token of t.split(/[／；;]/)) {
      token = token.trim()
        .replace(/^\*\*[^*]+\*\*[：:]\s*/, '') // 「**第三代**：」等小节内标签
        .replace(/\s*[（(][^）)]*[）)]/g, ''); // 「（非海面场景）」等场景注解
      if (!token || token.includes('**') || /[a-zA-Z ]/.test(token)) continue;
      const bare = token.replace(/…+/g, '');
      if (!bare) continue; // 纯省略号等无效词条
      // 片段按省略号切出（≥2 字）；单字词条（拟声「轰」）无片段，覆盖判定走 raw 精确匹配
      const parts = bare.length >= 2 ? token.split(/…+/).filter((p) => p.length >= 2) : [];
      entries.push({ raw: token, parts });
      seen.set(token, (seen.get(token) || 0) + 1);
    }
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([w]) => w);
  return { entries, dups };
}

// 从 lint.mjs 源码提取 BANNED 数组词条
function extractBanned(src) {
  const m = src.match(/const BANNED = \[([\s\S]*?)\];/);
  if (!m) throw new Error('lint.mjs 中找不到 BANNED 数组');
  const words = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const seen = new Map();
  for (const w of words) seen.set(w, (seen.get(w) || 0) + 1);
  return { words, dups: [...seen.entries()].filter(([, n]) => n > 1).map(([w]) => w) };
}

// ---------------- 主流程 ----------------

if (!existsSync(mdPath)) {
  console.error('FAIL — 找不到 skills/novel-ai-lexicon/SKILL.md。skills 是子模块：先跑 git submodule update --init');
  process.exit(2);
}

const md = readFileSync(mdPath, 'utf8');
const lintSrc = readFileSync(lintPath, 'utf8');

let skill;
let banned;
try {
  skill = extractLevel1Entries(md);
  banned = extractBanned(lintSrc);
} catch (err) {
  console.error(`FAIL — ${err.message}`);
  process.exit(2);
}

// 正向：skill 一级区词条是否都被 BANNED 覆盖（单字词条走 raw 精确匹配）
const missingInLint = skill.entries.filter(({ raw, parts }) => !banned.words.some((b) => b === raw)
  && !parts.some((p) => banned.words.some((b) => b === p || (b.length < p.length && p.includes(b)))));

// 反向：BANNED 词条是否有一级区出处（或已豁免）
const partTexts = skill.entries.flatMap((e) => e.parts);
const unexplainedInLint = banned.words.filter((b) => !BANNED_OUTSIDE.has(b)
  && !skill.entries.some(({ raw, parts }) => b === raw || parts.some((p) => p.includes(b))));

console.log(`词库同步校验：skill 一级区 ${skill.entries.length} 词条（含 ${skill.entries.filter((e) => e.parts.length > 1).length} 个省略号模板）↔ lint BANNED ${banned.words.length} 词`);

let failed = false;
if (skill.dups.length) {
  failed = true;
  console.log(`\n[skill 一级区重复词条] ${skill.dups.join('、')}`);
}
if (banned.dups.length) {
  failed = true;
  console.log(`\n[BANNED 重复词条] ${banned.dups.join('、')}`);
}
if (missingInLint.length) {
  failed = true;
  console.log(`\n[skill 一级区有、lint 漏收 ${missingInLint.length} 条]（正文里的这些表达不会被 novel_lint 拦截）`);
  for (const { raw, parts } of missingInLint) {
    console.log(`  - ${raw}${parts.length > 1 ? `（模板，片段：${parts.join('／')}）` : ''}`);
  }
}
if (unexplainedInLint.length) {
  failed = true;
  console.log(`\n[lint 有、一级区无出处且未豁免 ${unexplainedInLint.length} 条]（补进 skill 一级区，或在 BANNED_OUTSIDE 登记来源）`);
  console.log(`  ${unexplainedInLint.join('、')}`);
}

if (failed) {
  console.log('\nFAIL — 词库不同步，见上清单');
  process.exit(1);
}
console.log('OK — 词库同步');
