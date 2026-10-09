// 正文铁律确定性检查（纯代码规则，不调用模型）——插件与 WebUI 服务共享的唯一实现。
// -----------------------------------------------------------------------------
// 由 plugins/novel-tools.mjs（novel_lint / 保存章节门禁）与 webui/server.mjs
// （工具箱「AI 味检查」、章节保存门禁）共同 import，规则只在这一处维护。
//
// 把「正文铁律」中可量化的规则编译为计数/正则检查：能数出来的（标点、禁词、
// 副词频次、句式频次、比喻密度、句长波动、同句式连用）交给代码逐条核对，
// 模型自查只兜底不可量化项（视角越界、情绪标签、说明书腔）。
// 返回 { hardCount, softCount, report }：hard=必须修的硬违规，soft=建议逐条核对。
// 部分指标设计思路参考 MIT 开源项目 chinese-webnovel-skills（网文工坊，
// github.com/tance-mang/chinese-webnovel-skills），实现为本项目独立编写；
// 详见 README「参考来源与致谢」。

export function lintText(body) {
  const issues = [];
  const occurs = (w) => body.split(w).length - 1;
  const countRe = (re) => (body.match(re) || []).length;

  // 硬违规：标点纪律（整章级）
  const dash = countRe(/——/g);
  if (dash > 1) issues.push(['hard', `破折号（——）出现 ${dash} 次`, '整章上限 1 次，且只用于对话被打断']);
  const ellipsis = countRe(/……/g);
  if (ellipsis > 2) issues.push(['hard', `省略号（……）出现 ${ellipsis} 次`, '整章上限 2 次，只用于对话犹豫']);
  const semis = countRe(/；/g);
  if (semis > 0) issues.push(['hard', `正文出现分号 ${semis} 处`, '正文不用分号；一句话说不完拆成两句']);
  // 硬违规：感叹号按段（一段最多 1 个）
  const badPara = [];
  for (const p of body.split(/\n+/)) {
    if (!p.trim()) continue;
    const n = (p.match(/[！!]/g) || []).length;
    if (n > 1) badPara.push(p.trim().slice(0, 14));
  }
  if (badPara.length) issues.push(['hard', `${badPara.length} 个段落感叹号超过 1 个`, `如“${badPara[0]}…”`]);
  // 硬违规：标点堆砌情绪
  const stacked = countRe(/[？！]{2,}|[。]{3,}/g);
  if (stacked > 0) issues.push(['hard', `标点堆砌（？？/！！等）${stacked} 处`, '禁止用标点堆砌情绪']);
  // 硬违规：正文残留 Markdown
  if (/^#{1,6}\s|\*\*|```/.test(body)) issues.push(['hard', '正文残留 Markdown 符号（#/```/加粗）', '正文必须纯文本']);
  // 硬违规：简体网文标点规范——直角引号/英文引号/错误省略号/装饰符号
  const cornerQuotes = countRe(/[「」『』]/g);
  if (cornerQuotes > 0) issues.push(['hard', `直角引号「」『』出现 ${cornerQuotes} 处`, '简体网文用弯双引号""（嵌套用\'\'），不用直角引号']);
  const engQuotes = countRe(/["][^"\n]{1,40}["]/g);
  if (engQuotes > 0) issues.push(['hard', `疑似英文直引号 "…" 出现 ${engQuotes} 处`, '一律改为中文弯引号""']);
  const badEllipsis = countRe(/\.\.\.|。。。/g);
  if (badEllipsis > 0) issues.push(['hard', `错误省略号（.../。。。）出现 ${badEllipsis} 处`, '中文省略号用 ……（六点一个标点）']);
  const decorations = countRe(/[✦✨◆●★☆♦❖✳✴]/g);
  if (decorations > 0) issues.push(['hard', `装饰符号（✦✨◆★等）出现 ${decorations} 处`, '正文与标题一律不撒装饰符号，分隔用空行']);

  // 软违规：禁用词与模板化表达（一级套路化，出现即改；分级词库见 novel-ai-lexicon skill）
  const banned = ['心中一沉', '瞳孔骤缩', '倒吸一口凉气', '后背发凉', '心脏漏跳', '指尖微颤', '眼底闪过', '嘴角勾起', '勾起一抹', '嘴角微微上扬', '嘴角扬起', '面色一变', '神色复杂', '眼中闪过', '心中一凛', '心中一动', '心下了然', '心中了然', '指节泛白', '指节发白', '微微挑眉', '不容置疑', '不可置信', '行云流水', '话锋一转', '眼神深邃', '目瞪口呆', '嘴巴张得能塞下', '时间仿佛', '像淬了毒', '重重砸在', '眼中流露出', '空气凝滞', '空气安静', '空气瞬间安静', '脸上堆满了笑', '世界都安静', '远没有这么简单', '不知过了多久', '一室寂静', '难以言喻', '无法形容', '意味深长', '耐人寻味', '他不知道的是', '复杂的情绪', '眼眸', '薄唇', '不卑不亢', '隐隐有了猜测', '近乎偏执', '力道大得惊人', '让空气的温度都下降', '透露出的寒意', '像在看一个',
    // 第二代伪外化与套话（AI 味新特征，见 novel-ai-lexicon 结构层）
    '呼吸一滞', '呼吸一窒', '心头一紧', '喉结', '指腹摩挲', '眸光', '眸色', '眸子', '眸底', '笑意不达眼底', '几不可察', '几不可闻', '气氛降到', '沉默蔓延', '过了一个世纪', '才刚刚开始', '深不可测', '高深莫测',
    // 数字装具体（秒表式计时与“第 N 次”模板）
    '沉默了三秒', '沉默了几秒', '停顿了几秒', '停顿了三秒', '三秒后', '几秒钟后', '两秒钟', '第无数次', '数不清第几次'];
  const bannedHits = [];
  for (const w of banned) {
    const n = occurs(w);
    if (n > 0) bannedHits.push(`“${w}”×${n}`);
  }
  if (bannedHits.length) issues.push(['soft', '禁用词/模板化表达', bannedHits.join('、')]);
  // 软违规：万能量词
  const quantHits = [];
  for (const w of ['一丝', '一抹', '几分', '一股', '些许']) {
    const n = occurs(w);
    if (n > 0) quantHits.push(`“${w}”×${n}`);
  }
  if (quantHits.length) issues.push(['soft', '万能量词', `${quantHits.join('、')}（全砍）`]);
  // 软违规：副词/高频词频次（每词上限 2 次；二级词库见 novel-ai-lexicon）
  const advHits = [];
  for (const w of ['缓缓', '轻轻', '微微', '不由得', '忍不住', '下意识地', '突然', '忽然', '猛地', '顿时', '瞬间', '立刻', '连忙', '渐渐', '显然', '果然', '沉吟', '小心翼翼', '不动声色', '似乎', '淡淡', '不禁', '深吸一口气', '下一秒', '下一瞬', '随即', '旋即', '闻言', '见状', '注视', '凝视']) {
    const n = occurs(w);
    if (n > 2) advHits.push(`“${w}”×${n}`);
  }
  if (advHits.length) issues.push(['soft', '副词/高频词频次超限（每词上限 2 次）', advHits.join('、')]);
  // 软违规：次高频词密度（正常词限频不限用，每词上限 3 次；超限说明落入模板）
  const softHits = [];
  for (const w of ['顿了顿', '沉默', '苦笑', '无奈', '半晌', '回过神', '一时间', '若有所思', '似笑非笑', '攥紧']) {
    const n = occurs(w);
    if (n > 3) softHits.push(`“${w}”×${n}`);
  }
  if (softHits.length) issues.push(['soft', '次高频词密度超限（每词上限 3 次）', `${softHits.join('、')}——正常词限频不限用，超限说明写成了模板反应`]);
  // 软违规：极端词堆砌（密度制：每千字 ≤2）
  const kChars = Math.max(1, Math.round(body.replace(/\s+/g, '').length / 1000));
  const extreme = ['非常', '极其', '极大', '无比', '十分', '瞬间', '顿时', '刹那'];
  const extremeTotal = extreme.reduce((s, w) => s + occurs(w), 0);
  if (extremeTotal > kChars * 2) issues.push(['soft', `极端词 ${extremeTotal} 个（约 ${kChars} 千字）`, '密度应 ≤2/千字；程度靠具体画面给，删九成']);
  // 软违规：句式频次
  const buShi = countRe(/不是[^。！？\n]{0,30}而是/g);
  if (buShi > 1) issues.push(['soft', `“不是……而是……”出现 ${buShi} 次`, '整章上限 1 次']);
  const jiuZai = countRe(/就在这时|刹那间|的瞬间|此刻|这一刻|一时之间/g);
  if (jiuZai > 2) issues.push(['soft', `“就在这时/刹那间/的瞬间/此刻/这一刻”合计 ${jiuZai} 次`, '整章合计上限 2 次']);
  // 软违规：比喻引导词密度（同一引导词上限 3）
  const simileHits = [];
  const likeCount = countRe(/(?<![画肖雕影录照相])像/g);
  if (likeCount > 3) simileHits.push(`“像”×${likeCount}`);
  for (const w of ['仿佛', '如同', '宛如', '恰似']) {
    const n = occurs(w);
    if (n > 3) simileHits.push(`“${w}”×${n}`);
  }
  if (simileHits.length) issues.push(['soft', '比喻引导词频次（同一引导词上限 3，一段最多一个比喻）', simileHits.join('、')]);
  // 软违规：AI 转折词/书面连接词/论文腔
  const aiConn = ['然而，', '与此同时', '不仅如此', '值得一提的是', '不得不说', '综上所述', '由此可见', '某种意义上', '总而言之'];
  const aiConnHits = aiConn.filter((w) => occurs(w) > 0).map((w) => `“${w.replace(/，$/, '')}”`);
  if (aiConnHits.length) issues.push(['soft', 'AI 转折词/书面连接词', `${aiConnHits.join('、')}——删掉或换成口语衔接`]);
  // 软违规：句长过于均匀（句长波动检测：段内长短句应有落差）
  const sentences = body.split(/[。！？\n]+/).map((s) => s.trim()).filter((s) => s.length > 1);
  if (sentences.length >= 8) {
    const lens = sentences.map((s) => s.length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((s, l) => s + (l - avg) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / avg; // 变异系数
    const shortCount = lens.filter((l) => l <= 8).length;
    if (cv < 0.35 && shortCount < 3) issues.push(['soft', `句长过于均匀（变异系数 ${cv.toFixed(2)}，短句仅 ${shortCount} 个）`, '长短句要有落差：加碎句/单句成段，偶尔来一个 40 字长句']);
  }
  // 软违规：连续同句式开头（连续 3+ 句以相同人称代词/人名开头）
  const starts = sentences.map((s) => (s.match(/^(他|她|它|我|你|林|苏|叶|楚|萧|陈|秦|李|张|王|刘|周|赵)/) || [])[1]).filter(Boolean);
  let run = 1; let maxRun = 1;
  for (let i = 1; i < starts.length; i += 1) {
    if (starts[i] === starts[i - 1]) { run += 1; maxRun = Math.max(maxRun, run); } else run = 1;
  }
  if (maxRun >= 4) issues.push(['soft', `连续 ${maxRun} 句以“${starts[0] || '同一人称'}”类开头`, '连续同句式是强 AI 特征：换主语、倒装、或用动作句切入']);
  // 软违规：心理描写密度（一章不超 5 处）
  const psych = countRe(/心中|心头|涌上|感到/g);
  if (psych > 5) issues.push(['soft', `心理/情绪标签类表达约 ${psych} 处`, '心理描写一章不超 5 处，改用行为外化']);
  // 软违规：对话标签密度（AI 每句对话都挂“X道”类标签；真人多数靠上下文与动作识别说话人）
  const quoteLines = Math.floor(countRe(/[“”]/g) / 2);
  const tagTotal = ['说道', '问道', '答道', '应道', '开口道', '开口说道', '沉声道', '冷声道', '淡淡道', '低声道', '轻声道', '缓缓开口', '笑道', '叹道', '应了一声'].reduce((s, w) => s + occurs(w), 0);
  if (tagTotal > Math.max(6, quoteLines * 0.5)) issues.push(['soft', `对话标签约 ${tagTotal} 个（引号句约 ${quoteLines} 句）`, '半数以上对话挂“X道”类标签是 AI 特征：能删则删，用动作行代替']);
  // 软违规：段尾总结句（每段最后一句都在收束/点题/升华）
  const tailSummary = body.split(/\n+/).map((p) => p.trim()).filter(Boolean)
    .map((p) => (p.split(/(?<=[。！？…])/).pop() || '').trim())
    .filter((s) => /^(他知道|她知道|他明白|她明白|这一刻，|这一次，|或许，|也许，|仿佛)/.test(s)).length;
  if (tailSummary > 2) issues.push(['soft', `${tailSummary} 个段落以总结/点题句收尾`, '段尾停在动作、台词或物证上，不要每段都收束']);
  // 软违规：章末模板收尾（气氛句/升华句当钩子）
  const tailText = body.slice(-80);
  const hookTpl = ['才刚刚开始', '夜，深了', '夜色渐深', '故事，才', '他知道，这一切', '他不知道的是'].filter((w) => tailText.includes(w));
  if (hookTpl.length) issues.push(['soft', `章末疑似模板收尾（${hookTpl.join('、')}）`, '钩子必须是具体事件或具体台词，不是气氛句']);

  const hardCount = issues.filter((i) => i[0] === 'hard').length;
  const softCount = issues.length - hardCount;
  const lines = [];
  if (!issues.length) lines.push('通过：未发现可量化的铁律违规（视角越界、说明书腔、情绪太平均等不可量化项仍需人工/模型自查）。');
  for (const [level, name, detail] of issues) {
    lines.push(`- ${level === 'hard' ? '【必须修】' : '【建议查】'}${name}——${detail}`);
  }
  return { hardCount, softCount, report: lines.join('\n') };
}

// 章节标题识别（与 novel_import / WebUI 旧稿分章共用同一条规则）
export const chapterHeadingRe = /^第[0-9零一二三四五六七八九十百千两]+[章回节].{0,30}$/;
