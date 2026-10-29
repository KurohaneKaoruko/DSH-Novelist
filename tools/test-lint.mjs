#!/usr/bin/env node
// 正文检查引擎单测（plugins/lint.mjs + plugins/novel-tools.mjs 的伏笔体检）
// -----------------------------------------------------------------------------
// 预设的核心价值是「确定性检查」，但此前只有安装冒烟、没有规则级回归。
// 这里用零依赖的断言表把每条规则的判定钉住：
//   · 该报的必须报（正向）；
//   · 干净稿不许误报 hard（反向）；
//   · 已修过的判定缺陷（连续同句式开头报错人称、长短禁词重复计数）单独回归。
//
// 跑法：node test-lint.mjs    （CI 的 verify 工作流会跑）

import { lintText } from '../plugins/lint.mjs';
import { auditForeshadow } from '../plugins/novel-tools.mjs';

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// 断言某个 issue 存在（level 精确匹配，name 含子串）
function assertIssue(result, level, namePart, label) {
  const hit = result.issues.find((i) => i[0] === level && i[1].includes(namePart));
  assert(hit, `${label}：未报出 ${level} 项「${namePart}」。实际：${result.issues.map((i) => `[${i[0]}]${i[1]}`).join(' / ') || '（无）'}`);
  return hit;
}

// 断言某个 issue 不存在
function assertNoIssue(result, namePart, label) {
  const hit = result.issues.find((i) => i[1].includes(namePart));
  assert(!hit, `${label}：不应报出「${namePart}」，实际报了：${hit ? hit[1] : ''}`);
}

// ---------------- 样本 ----------------

// 干净稿：不触发任何 hard，也不触发主要 soft
const CLEAN = [
  '雨点砸在铁皮棚上，声音乱成一片。',
  '老陈把烟摁灭在鞋底，抬头看了看巷口。',
  '那盏路灯又坏了，一闪一闪，像有人在上头按开关。',
  '他拎起工具箱，往雨里走。',
  '巷子尽头停着一辆黑色面包车，车牌被泥糊住了。',
  '老陈蹲下去，伸手抹了一把。',
  '泥底下露出半个字，是个“京”字。',
].join('');

console.log('正文检查引擎单测\n');

// ---------------- 一、硬违规：标点纪律 ----------------
check('破折号超过 1 次报 hard', () => {
  const r = lintText('他停了——然后又走——最后还是回头。');
  assertIssue(r, 'hard', '破折号', '破折号');
});

check('省略号超过 2 次报 hard', () => {
  const r = lintText('他想了想……又摇头……再点头……最后没说话。');
  assertIssue(r, 'hard', '省略号', '省略号');
});

check('正文出现分号报 hard', () => {
  const r = lintText('他推开门；屋里没人。');
  assertIssue(r, 'hard', '分号', '分号');
});

check('单段两个感叹号报 hard', () => {
  const r = lintText('快跑！别回头！');
  assertIssue(r, 'hard', '感叹号', '感叹号');
});

check('标点堆砌报 hard', () => {
  const r = lintText('你说什么？？');
  assertIssue(r, 'hard', '标点堆砌', '标点堆砌');
});

// ---------------- 二、硬违规：标点规范 ----------------
check('直角引号报 hard', () => {
  const r = lintText('他说：「走吧。」');
  assertIssue(r, 'hard', '直角引号', '直角引号');
});

check('英文直引号报 hard', () => {
  const r = lintText('他说："走吧。"');
  assertIssue(r, 'hard', '英文直引号', '英文直引号');
});

check('错误省略号（...）报 hard', () => {
  const r = lintText('他想了想...然后走了。');
  assertIssue(r, 'hard', '错误省略号', '错误省略号');
});

check('装饰符号报 hard', () => {
  const r = lintText('★ 第一章 开端');
  assertIssue(r, 'hard', '装饰符号', '装饰符号');
});

check('Markdown 残留报 hard（段落中间也要抓）', () => {
  const r = lintText('他推开门。\n\n## 第二天\n\n屋里没人。');
  assertIssue(r, 'hard', 'Markdown', 'Markdown');
});

check('正文里加粗标记报 hard', () => {
  const r = lintText('他推开门，**屋里没人**。');
  assertIssue(r, 'hard', 'Markdown', '加粗');
});

check('弯双引号不配对报 hard', () => {
  const r = lintText('他说：“走吧。她又补了一句：“快点。”');
  assertIssue(r, 'hard', '弯双引号不配对', '引号配对');
});

check('圆括号不配对报 hard', () => {
  const r = lintText('他掏出怀表（那是父亲留下的，看了很久。');
  assertIssue(r, 'hard', '圆括号不配对', '括号配对');
});

check('中文句子里的半角逗号报 hard', () => {
  const r = lintText('他推开门,屋里没人。');
  assertIssue(r, 'hard', '半角标点', '半角逗号');
});

check('数字里的半角标点不误报', () => {
  const r = lintText('他数了 3.5 米，又量了 10:30 的时间。');
  assertNoIssue(r, '半角标点', '数字半角');
});

// ---------------- 三、软违规：词与频次 ----------------
check('禁用词报 soft', () => {
  const r = lintText('他心中一沉，瞳孔骤缩。');
  assertIssue(r, 'soft', '禁用词', '禁用词');
});

check('长短禁词重叠时只报长词（不重复计数）', () => {
  const r = lintText('空气瞬间安静下来。');
  const hit = assertIssue(r, 'soft', '禁用词', '重叠禁词');
  assert(hit[2].includes('空气瞬间安静'), `应报长词「空气瞬间安静」，实际：${hit[2]}`);
  assert(!hit[2].includes('“空气安静”'), `不应重复报短词「空气安静」，实际：${hit[2]}`);
});

check('万能量词报 soft', () => {
  const r = lintText('他脸上露出一丝笑意，带着一抹疲惫。');
  assertIssue(r, 'soft', '万能量词', '量词');
});

check('副词超过 2 次报 soft', () => {
  const r = lintText('他缓缓起身，缓缓推门，缓缓回头。');
  assertIssue(r, 'soft', '副词', '副词频次');
});

check('极端词密度超限报 soft', () => {
  const r = lintText('非常安静，非常冷，非常黑，非常远，非常久，非常累。');
  assertIssue(r, 'soft', '极端词', '极端词密度');
});

check('AI 转折词报 soft', () => {
  const r = lintText('然而，他没有走。');
  assertIssue(r, 'soft', 'AI 转折词', '转折词');
});

check('“不是……而是……”零容忍报 soft（回归：曾是整章限 1 次）', () => {
  const r = lintText('这不是结束，而是新的开始。');
  const hit = assertIssue(r, 'soft', '不是……而是', '不是而是');
  assert(hit[2].includes('零容忍'), `修复建议应含「零容忍」指引，实际：${hit[2]}`);
});

check('迂回定义句式家族报 soft', () => {
  const r = lintText('那不是愤怒，是恐惧。这并非巧合。这不仅仅是一场比赛。与其说是指导，不如说是监视。他要的从来不是钱。');
  const hit = assertIssue(r, 'soft', '迂回定义', '迂回定义');
  for (const part of ['不是……，是……', '并非', '不仅仅是', '与其说是', '从来不是']) {
    assert(hit[2].includes(part), `应报出「${part}」，实际：${hit[2]}`);
  }
});

check('对话内澄清与正常否定不误报迂回定义', () => {
  const r = lintText('他说：“我说的不是这个意思。”屋里没有人。他不再犹豫，转身就走。');
  assertNoIssue(r, '迂回定义', '迂回定义误报');
  assertNoIssue(r, '不是……而是', '不是而是误报');
});

check('万能群像反应词报 soft（四目相对/相视一笑等）', () => {
  const r = lintText('两人四目相对，随后相视一笑，一切尽在不言中。');
  assertIssue(r, 'soft', '禁用词', '群像反应');
});

check('情绪成语标签报 soft（如释重负/五味杂陈等）', () => {
  const r = lintText('听完这话，她如释重负地笑了。他心里五味杂陈。');
  assertIssue(r, 'soft', '禁用词', '情绪成语');
});

check('生理反应第三代报 soft（头皮发麻/大脑一片空白等）', () => {
  const r = lintText('那个念头让他头皮发麻，大脑一片空白。');
  assertIssue(r, 'soft', '禁用词', '生理第三代');
});

check('声音万能框架与翻译腔弱动词报 soft', () => {
  const r = lintText('笑声在走廊里回荡着。他们进行了一次深入的谈话。');
  assertIssue(r, 'soft', '禁用词', '回荡');
  assertIssue(r, 'soft', '禁用词', '进行了一次');
});

check('看似/实则评论腔报 soft', () => {
  const r = lintText('他看似平静，实则慌得不行。');
  assertIssue(r, 'soft', '禁用词', '看似实则');
});

check('“当……的时候”超 1 次报 soft', () => {
  const r = lintText('当他推开门的时候，屋里一片漆黑。当他回头的时候，走廊已空无一人。');
  assertIssue(r, 'soft', '当……的时候', '当时候');
});

check('“不知是……还是……”超 1 次报 soft，单次不报', () => {
  const multi = lintText('她不知道是该哭还是该笑。他不知道是该走还是该留。');
  assertIssue(multi, 'soft', '不知是', '不知还是');
  const single = lintText('不知是谁家的狗，叫了两声又不叫了。');
  assertNoIssue(single, '不知是', '不知还是单次');
});

check('“或许……，或许……”列举超 1 次报 soft', () => {
  const r = lintText('或许是累了吧，或许是怕了吧，他说不清。也许是晚了，也许是他累了，谁知道。'.replace(/也许/g, '或许'));
  assertIssue(r, 'soft', '或许', '或许列举');
});

check('“一种难以……的感觉”零容忍报 soft', () => {
  const r = lintText('心里涌起一股难以言说的滋味。');
  assertIssue(r, 'soft', '难以', '难以感觉');
});

check('举例/解释框架报 soft（正文不是说明文）', () => {
  const r = lintText('比如说，这门手艺讲究慢工。简而言之，他输了。');
  assertIssue(r, 'soft', '举例/解释框架', '举例框架');
});

// ---------------- 四、软违规：句式与结构 ----------------
check('连续同句式开头报 soft，且报出正确的人称（回归：曾误报首句人称）', () => {
  const r = lintText('她把伞收起来，靠在门边。他走过去。他停下来。他回头看了一眼。他什么也没说。');
  const hit = assertIssue(r, 'soft', '连续', '同句式开头');
  assert(hit[1].includes('“他”'), `应报连续 4 句以「他」开头，实际：${hit[1]}`);
  assert(!hit[1].includes('“她”'), `不应误报「她」，实际：${hit[1]}`);
});

check('整句重复报 soft', () => {
  const line = '老陈把工具箱放在门槛上，蹲下来数里面的扳手。';
  const r = lintText(`${line}${line}`);
  assertIssue(r, 'soft', '整句重复', '整句重复');
});

check('段落开头雷同报 soft', () => {
  const r = lintText('雨还在下，他站在门口。\n雨还在下，屋檐在滴水。\n雨还在下，巷子里没人。\n雨还在下，远处有狗叫。');
  assertIssue(r, 'soft', '段以', '段落开头');
});

check('对话标签过密报 soft', () => {
  const r = lintText('“走吧。”他说道。“去哪。”她问道。“随便。”他答道。“那就走。”她应道。“好。”他笑道。“嗯。”她叹道。“快点。”他沉声道。');
  assertIssue(r, 'soft', '对话标签', '对话标签');
});

check('章节字数低于默认区间报 soft', () => {
  const filler = [];
  for (let i = 0; i < 45; i += 1) filler.push(`巷子第${i + 1}个拐角堆着纸箱，雨水顺着箱缝往下淌。`);
  const r = lintText(filler.join(''));
  assertIssue(r, 'soft', '低于默认区间', '字数下限');
});

// ---------------- 五、反向：干净稿不误报 ----------------
check('干净稿无硬违规', () => {
  const r = lintText(CLEAN);
  assert(r.hardCount === 0, `干净稿报了 ${r.hardCount} 项硬违规：${r.issues.filter((i) => i[0] === 'hard').map((i) => i[1]).join(' / ')}`);
});

check('干净稿不触发主要软违规', () => {
  const r = lintText(CLEAN);
  for (const part of ['禁用词', '万能量词', '副词', '整句重复', '段落', '对话标签', '章末']) {
    assertNoIssue(r, part, '干净稿');
  }
});

check('短片段不触发章节字数提示', () => {
  const r = lintText('他推开门，屋里没人。');
  assertNoIssue(r, '默认区间', '短片段');
});

check('返回结构稳定（hardCount/softCount/issues/report）', () => {
  const r = lintText(CLEAN);
  assert(typeof r.hardCount === 'number', 'hardCount 类型错误');
  assert(typeof r.softCount === 'number', 'softCount 类型错误');
  assert(Array.isArray(r.issues), 'issues 应为数组');
  assert(typeof r.report === 'string' && r.report.length > 0, 'report 应为非空字符串');
});

// ---------------- 六、伏笔体检 ----------------
const FS_TABLE = [
  '| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |',
  '| --- | --- | --- | --- | --- |',
  '| 玄铁令牌 | 第003章 | 出现两次 | — | 未回收 |',
  '| 老宅钥匙 | 第002章 | 一次 | 第010章 | 已回收 |',
  '| 神秘来信 | 第012章 | — | — | 推进中 |',
].join('\n');

check('伏笔体检：解析条数、未回收数、超期条目', () => {
  const a = auditForeshadow(FS_TABLE, 20);
  assert(a, '应解析出结果');
  assert(a.total === 3, `总条数应为 3，实际 ${a.total}`);
  assert(a.openCount === 2, `未回收应为 2，实际 ${a.openCount}`);
  assert(a.stale.length === 1, `超期应为 1 条，实际 ${a.stale.length}`);
  assert(a.stale[0].name === '玄铁令牌', `超期条目应为玄铁令牌，实际 ${a.stale[0].name}`);
  assert(a.stale[0].gap === 17, `悬空章数应为 17，实际 ${a.stale[0].gap}`);
});

check('伏笔体检：全部回收时无超期条目', () => {
  const table = '| 伏笔 | 铺设位置 | 状态 |\n| --- | --- | --- |\n| 甲 | 第001章 | 已回收 |\n| 乙 | 第002章 | 已回收 |';
  const a = auditForeshadow(table, 50);
  assert(a && a.openCount === 0, `未回收应为 0，实际 ${a && a.openCount}`);
  assert(a.stale.length === 0, `超期应为 0，实际 ${a.stale.length}`);
});

check('伏笔体检：空表/非表格返回 null', () => {
  assert(auditForeshadow('', 10) === null, '空表应返回 null');
  assert(auditForeshadow('# 伏笔清单\n\n（暂无）', 10) === null, '非表格应返回 null');
});

check('伏笔体检：缺少章号时不算悬空，但保留条目', () => {
  const table = '| 伏笔 | 铺设位置 | 状态 |\n| --- | --- | --- |\n| 甲 | 未定 | 未回收 |';
  const a = auditForeshadow(table, 30);
  assert(a.total === 1 && a.openCount === 1, '应保留 1 条未回收');
  assert(a.stale.length === 0, '无章号不应判为超期');
});

// ---------------- 汇总 ----------------
console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log(`  · ${f.name}: ${f.message}`);
  process.exit(1);
}
