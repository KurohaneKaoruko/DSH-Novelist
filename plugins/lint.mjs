// 小说助手 · 正文铁律确定性检查引擎
// -----------------------------------------------------------------------------
// 纯函数、零依赖、零模型调用：输入一段正文，输出硬/软违规清单。
//
// 从 novel-tools.mjs 拆出为独立模块，原因有两个：
//   1. 可被 tools/test-lint.mjs 直接 import 做单测（规则改动的回归保障）；
//   2. 检查引擎与工具装配解耦，novel_lint 与 novel_project 的保存门禁共用同一份实现。
//
// 分级约定：
//   hard = 必须修的硬违规（标点、引号、Markdown 残留、结构错配），修复后才允许落盘；
//   soft = 建议逐条核对的软违规（禁词、频次、句式密度），语境误报可忽略。
//

// ---------------- 词库 ----------------

// 禁用词与模板化表达（一级套路化，出现即改；分级词库见 novel-ai-lexicon skill）
const BANNED = [
  '心中一沉', '瞳孔骤缩', '倒吸一口凉气', '后背发凉', '心脏漏跳', '指尖微颤', '眼底闪过', '嘴角勾起', '勾起一抹', '嘴角微微上扬', '嘴角扬起', '面色一变', '神色复杂', '眼中闪过', '心中一凛', '心中一动', '心下了然', '心中了然', '指节泛白', '指节发白', '微微挑眉', '不容置疑', '不可置信', '行云流水', '话锋一转', '眼神深邃', '目瞪口呆', '嘴巴张得能塞下', '时间仿佛', '像淬了毒', '重重砸在', '眼中流露出', '空气凝滞', '空气安静', '空气瞬间安静', '脸上堆满了笑', '世界都安静', '远没有这么简单', '不知过了多久', '一室寂静', '难以言喻', '无法形容', '意味深长', '耐人寻味', '他不知道的是', '复杂的情绪', '眼眸', '薄唇', '不卑不亢', '隐隐有了猜测', '近乎偏执', '力道大得惊人', '让空气的温度都下降', '透露出的寒意', '像在看一个',
  // 第二代伪外化与套话（AI 味新特征，见 novel-ai-lexicon 结构层）
  '呼吸一滞', '呼吸一窒', '心头一紧', '喉结', '指腹摩挲', '眸光', '眸色', '眸子', '眸底', '笑意不达眼底', '几不可察', '几不可闻', '气氛降到', '沉默蔓延', '过了一个世纪', '才刚刚开始', '深不可测', '高深莫测',
  // 数字装具体（秒表式计时与“第 N 次”模板）
  '沉默了三秒', '沉默了几秒', '停顿了几秒', '停顿了三秒', '三秒后', '几秒钟后', '两秒钟', '第无数次', '数不清第几次',
];

// 万能量词（全砍）
const QUANTIFIERS = ['一丝', '一抹', '几分', '一股', '些许'];

// 副词/高频词（每词上限 2 次）
const ADVERBS = ['缓缓', '轻轻', '微微', '不由得', '忍不住', '下意识地', '突然', '忽然', '猛地', '顿时', '瞬间', '立刻', '连忙', '渐渐', '显然', '果然', '沉吟', '小心翼翼', '不动声色', '似乎', '淡淡', '不禁', '深吸一口气', '下一秒', '下一瞬', '随即', '旋即', '闻言', '见状', '注视', '凝视'];

// 次高频词（每词上限 3 次）
const SOFT_FREQ = ['顿了顿', '沉默', '苦笑', '无奈', '半晌', '回过神', '一时间', '若有所思', '似笑非笑', '攥紧'];

// 极端词（密度制：每千字 ≤2）
const EXTREME = ['非常', '极其', '极大', '无比', '十分', '瞬间', '顿时', '刹那'];

// AI 转折词/书面连接词
const AI_CONN = ['然而，', '与此同时', '不仅如此', '值得一提的是', '不得不说', '综上所述', '由此可见', '某种意义上', '总而言之'];

// 章末模板收尾（气氛句/升华句当钩子）
const TAIL_TEMPLATES = ['才刚刚开始', '夜，深了', '夜色渐深', '故事，才', '他知道，这一切', '他不知道的是'];

// 对话标签
const DIALOGUE_TAGS = ['说道', '问道', '答道', '应道', '开口道', '开口说道', '沉声道', '冷声道', '淡淡道', '低声道', '轻声道', '缓缓开口', '笑道', '叹道', '应了一声'];

// 常用主语/人称（连续同句式开头检测用）
const SUBJECT_START = /^(他|她|它|我|你|林|苏|叶|楚|萧|陈|秦|李|张|王|刘|周|赵)/;

// 段尾总结句
const TAIL_SUMMARY = /^(他知道|她知道|他明白|她明白|这一刻，|这一次，|或许，|也许，|仿佛)/;

// 默认章节字数区间（与 persona 的「单章默认标准」一致）
const CHAPTER_MIN = 2000;
const CHAPTER_MAX = 4000;

// ---------------- 引擎 ----------------

/**
 * 检查正文。
 * @param {string} body 正文纯文本
 * @returns {{hardCount: number, softCount: number, issues: Array<[string,string,string]>, report: string}}
 */
export function lintText(body) {
  const text = typeof body === 'string' ? body : '';
  const issues = [];
  const occurs = (w) => text.split(w).length - 1;
  const countRe = (re) => (text.match(re) || []).length;
  const chars = text.replace(/\s+/g, '').length;
  const push = (level, name, detail) => issues.push([level, name, detail]);

  // ── 一、标点纪律（整章级） ──────────────────────────────────────────
  const dash = countRe(/——/g);
  if (dash > 1) push('hard', `破折号（——）出现 ${dash} 次`, '整章上限 1 次，且只用于对话被打断');
  const ellipsis = countRe(/……/g);
  if (ellipsis > 2) push('hard', `省略号（……）出现 ${ellipsis} 次`, '整章上限 2 次，只用于对话犹豫');
  const semis = countRe(/；/g);
  if (semis > 0) push('hard', `正文出现分号 ${semis} 处`, '正文不用分号；一句话说不完拆成两句');

  // 感叹号按段（一段最多 1 个）
  const badPara = [];
  for (const p of text.split(/\n+/)) {
    if (!p.trim()) continue;
    const n = (p.match(/[！!]/g) || []).length;
    if (n > 1) badPara.push(p.trim().slice(0, 14));
  }
  if (badPara.length) push('hard', `${badPara.length} 个段落感叹号超过 1 个`, `如“${badPara[0]}…”`);

  const stacked = countRe(/[？！]{2,}|[。]{3,}/g);
  if (stacked > 0) push('hard', `标点堆砌（？？/！！等）${stacked} 处`, '禁止用标点堆砌情绪');

  // 正文残留 Markdown
  if (/^#{1,6}\s|\*\*|```/m.test(text)) push('hard', '正文残留 Markdown 符号（#/```/加粗）', '正文必须纯文本');

  // 简体网文标点规范——直角引号/英文引号/错误省略号/装饰符号
  const cornerQuotes = countRe(/[「」『』]/g);
  if (cornerQuotes > 0) push('hard', `直角引号「」『』出现 ${cornerQuotes} 处`, '简体网文用弯双引号“”（嵌套用‘’），不用直角引号');
  const engQuotes = countRe(/"[^"\n]{1,40}"/g);
  if (engQuotes > 0) push('hard', `疑似英文直引号 "…" 出现 ${engQuotes} 处`, '一律改为中文弯引号“”');
  const badEllipsis = countRe(/\.\.\.|。。。/g);
  if (badEllipsis > 0) push('hard', `错误省略号（.../。。。）出现 ${badEllipsis} 处`, '中文省略号用 ……（六点一个标点）');
  const decorations = countRe(/[✦✨◆●★☆♦❖✳✴]/g);
  if (decorations > 0) push('hard', `装饰符号（✦✨◆★等）出现 ${decorations} 处`, '正文与标题一律不撒装饰符号，分隔用空行');

  // 引号/括号配对：数量不等必然是漏写或错位，落盘前必须修
  const openQuote = countRe(/“/g);
  const closeQuote = countRe(/”/g);
  if (openQuote !== closeQuote) push('hard', `弯双引号不配对（“${openQuote} 个 / ”${closeQuote} 个）`, '补齐或删除多余的引号，引号必须成对出现');
  const openSingle = countRe(/‘/g);
  const closeSingle = countRe(/’/g);
  if (openSingle !== closeSingle) push('hard', `弯单引号不配对（‘${openSingle} 个 / ’${closeSingle} 个）`, '引语内嵌套的单引号必须成对');
  const openParen = countRe(/（/g);
  const closeParen = countRe(/）/g);
  if (openParen !== closeParen) push('hard', `圆括号不配对（（${openParen} 个 / ）${closeParen} 个）`, '补齐或删除多余的括号');

  // 半角标点混入中文句子（中文后紧跟 , ; ! ? 一律改全角）
  const halfWidth = countRe(/[\u4e00-\u9fff][,;!?]/g);
  if (halfWidth > 0) push('hard', `中文句子里的半角标点 ${halfWidth} 处（如“他,然后”）`, '中文正文一律用全角标点：，；！？');

  // ── 二、禁用词与模板化表达 ──────────────────────────────────────────
  const bannedTerms = BANNED.map((w) => [w, occurs(w)]).filter(([, n]) => n > 0);
  // 长短词重叠时只报长词（“空气瞬间安静”不再重复报“空气安静”）
  const bannedHits = bannedTerms
    .filter(([w, n]) => !bannedTerms.some(([w2, n2]) => w2 !== w && w2.includes(w) && n2 === n))
    .map(([w, n]) => `“${w}”×${n}`);
  if (bannedHits.length) push('soft', '禁用词/模板化表达', bannedHits.join('、'));

  const quantHits = QUANTIFIERS.map((w) => [w, occurs(w)]).filter(([, n]) => n > 0).map(([w, n]) => `“${w}”×${n}`);
  if (quantHits.length) push('soft', '万能量词', `${quantHits.join('、')}（全砍）`);

  const advHits = ADVERBS.map((w) => [w, occurs(w)]).filter(([, n]) => n > 2).map(([w, n]) => `“${w}”×${n}`);
  if (advHits.length) push('soft', '副词/高频词频次超限（每词上限 2 次）', advHits.join('、'));

  const softHits = SOFT_FREQ.map((w) => [w, occurs(w)]).filter(([, n]) => n > 3).map(([w, n]) => `“${w}”×${n}`);
  if (softHits.length) push('soft', '次高频词密度超限（每词上限 3 次）', `${softHits.join('、')}——正常词限频不限用，超限说明写成了模板反应`);

  // ── 三、密度与句式 ──────────────────────────────────────────────────
  const kChars = Math.max(1, Math.round(chars / 1000));
  const extremeTotal = EXTREME.reduce((s, w) => s + occurs(w), 0);
  if (extremeTotal > kChars * 2) push('soft', `极端词 ${extremeTotal} 个（约 ${kChars} 千字）`, '密度应 ≤2/千字；程度靠具体画面给，删九成');

  const buShi = countRe(/不是[^。！？\n]{0,30}而是/g);
  if (buShi > 1) push('soft', `“不是……而是……”出现 ${buShi} 次`, '整章上限 1 次');
  const jiuZai = countRe(/就在这时|刹那间|的瞬间|此刻|这一刻|一时之间/g);
  if (jiuZai > 2) push('soft', `“就在这时/刹那间/的瞬间/此刻/这一刻”合计 ${jiuZai} 次`, '整章合计上限 2 次');

  const simileHits = [];
  const likeCount = countRe(/(?<![画肖雕影录照相])像/g);
  if (likeCount > 3) simileHits.push(`“像”×${likeCount}`);
  for (const w of ['仿佛', '如同', '宛如', '恰似']) {
    const n = occurs(w);
    if (n > 3) simileHits.push(`“${w}”×${n}`);
  }
  if (simileHits.length) push('soft', '比喻引导词频次（同一引导词上限 3，一段最多一个比喻）', simileHits.join('、'));

  const aiConnHits = AI_CONN.filter((w) => occurs(w) > 0).map((w) => `“${w.replace(/，$/, '')}”`);
  if (aiConnHits.length) push('soft', 'AI 转折词/书面连接词', `${aiConnHits.join('、')}——删掉或换成口语衔接`);

  // ── 四、句子层：长度、开头、重复 ────────────────────────────────────
  const sentences = text.split(/[。！？\n]+/).map((s) => s.trim()).filter((s) => s.length > 1);

  // 句长过于均匀（段内长短句应有落差）
  if (sentences.length >= 8) {
    const lens = sentences.map((s) => s.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((s, l) => s + (l - avg) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / avg; // 变异系数
    const shortCount = lens.filter((l) => l <= 8).length;
    if (cv < 0.35 && shortCount < 3) {
      push('soft', `句长过于均匀（变异系数 ${cv.toFixed(2)}，短句仅 ${shortCount} 个）`, '长短句要有落差：加碎句/单句成段，偶尔来一个 40 字长句');
    }
  }

  // 连续同句式开头（连续 4+ 句以相同人称代词/人名开头）
  const starts = sentences.map((s) => (s.match(SUBJECT_START) || [])[1] || null);
  let run = 0;
  let maxRun = 0;
  let runStarter = null;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] && starts[i] === starts[i - 1]) run += 1;
    else run = starts[i] ? 1 : 0;
    if (run > maxRun) { maxRun = run; runStarter = starts[i]; }
  }
  if (maxRun >= 4) push('soft', `连续 ${maxRun} 句以“${runStarter || '同一人称'}”类开头`, '连续同句式是强 AI 特征：换主语、倒装、或用动作句切入');

  // 整句重复（同一句出现两次以上，多半是复制粘贴残留）
  const dupMap = new Map();
  for (const s of sentences) {
    const key = s.replace(/[“”‘’\s]/g, '');
    if (key.length < 12) continue;
    dupMap.set(key, (dupMap.get(key) || 0) + 1);
  }
  const dups = [...dupMap.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  if (dups.length) {
    const sample = dups.slice(0, 3).map(([s, n]) => `“${s.slice(0, 18)}…”×${n}`).join('、');
    push('soft', `整句重复 ${dups.length} 组`, `${sample}——确认是否复制粘贴残留；有意重复也要改写`);
  }

  // 段落开头雷同（连续 4 段以同两个字开头）
  const paraHeads = text.split(/\n+/)
    .map((p) => p.trim().replace(/^[“”‘’"'\s]+/, ''))
    .filter((p) => p.length >= 4)
    .map((p) => p.slice(0, 2));
  let pRun = 0;
  let pMaxRun = 0;
  let pStarter = null;
  for (let i = 0; i < paraHeads.length; i += 1) {
    if (paraHeads[i] === paraHeads[i - 1]) pRun += 1;
    else pRun = 1;
    if (pRun > pMaxRun) { pMaxRun = pRun; pStarter = paraHeads[i]; }
  }
  if (pMaxRun >= 4) push('soft', `连续 ${pMaxRun} 段以“${pStarter}”开头`, '段落开头要有变化：换视角人物、先给动作或环境、把短句单独成段');

  // ── 五、描写层：心理、对话标签、段尾 ────────────────────────────────
  const psych = countRe(/心中|心头|涌上|感到/g);
  if (psych > 5) push('soft', `心理/情绪标签类表达约 ${psych} 处`, '心理描写一章不超 5 处，改用行为外化');

  const quoteLines = Math.floor(countRe(/[“”]/g) / 2);
  const tagTotal = DIALOGUE_TAGS.reduce((s, w) => s + occurs(w), 0);
  if (tagTotal > Math.max(6, quoteLines * 0.5)) {
    push('soft', `对话标签约 ${tagTotal} 个（引号句约 ${quoteLines} 句）`, '半数以上对话挂“X道”类标签是 AI 特征：能删则删，用动作行代替');
  }

  const tailSummary = text.split(/\n+/).map((p) => p.trim()).filter(Boolean)
    .map((p) => (p.split(/(?<=[。！？…])/).pop() || '').trim())
    .filter((s) => TAIL_SUMMARY.test(s)).length;
  if (tailSummary > 2) push('soft', `${tailSummary} 个段落以总结/点题句收尾`, '段尾停在动作、台词或物证上，不要每段都收束');

  const tailText = text.slice(-80);
  const hookTpl = TAIL_TEMPLATES.filter((w) => tailText.includes(w));
  if (hookTpl.length) push('soft', `章末疑似模板收尾（${hookTpl.join('、')}）`, '钩子必须是具体事件或具体台词，不是气氛句');

  // ── 六、篇幅（默认标准 2000–4000 字） ───────────────────────────────
  // 只在正文已具章节体量（≥1000 字）时提示，避免片段检查刷屏
  if (chars >= 1000 && chars < CHAPTER_MIN) {
    push('soft', `本章 ${chars} 字，低于默认区间 ${CHAPTER_MIN}–${CHAPTER_MAX}`, '补足场景细节或增写一个推进情节的场面；用户另有要求则忽略');
  } else if (chars > CHAPTER_MAX) {
    push('soft', `本章 ${chars} 字，超出默认区间 ${CHAPTER_MIN}–${CHAPTER_MAX}`, '确认是否需要拆章；单章过长读者容易疲劳');
  }

  // ---------------- 汇总 ----------------
  const hardCount = issues.filter((i) => i[0] === 'hard').length;
  const softCount = issues.length - hardCount;
  const lines = [];
  if (!issues.length) lines.push('通过：未发现可量化的铁律违规（视角越界、说明书腔、情绪太平均等不可量化项仍需人工/模型自查）。');
  for (const [level, name, detail] of issues) {
    lines.push(`- ${level === 'hard' ? '【必须修】' : '【建议查】'}${name}——${detail}`);
  }
  return { hardCount, softCount, issues, report: lines.join('\n') };
}
