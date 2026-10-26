#!/usr/bin/env node
// 工具层集成测试（不依赖 dsh 内核）
// -----------------------------------------------------------------------------
// 安装冒烟只能证明「预设挂得上」，规则单测只能证明「lint 判得对」；工具之间的
// 工程流转（初始化 → 保存门禁 → 写前材料 → 统计 → 导入撞号保护）此前没有覆盖。
//
// 做法：用 node:fs 实现一份最小的 fs / sandboxPolicy 服务，直接调用插件导出的
// apply(ctx)，把注册出来的工具当成函数跑在临时目录里。零依赖，不需要 API Key。
//
// 跑法：node test-tools.mjs

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import plugin from '../plugins/novel-tools.mjs';

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
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

// ---------------- 最小服务替身 ----------------

const fsService = {
  async resolve(rel, opts) { return path.resolve((opts && opts.cwd) || '.', rel); },
  async readText(target) { return readFile(target, 'utf8'); },
  async writeText(target, text) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, 'utf8');
  },
  async listDir(target) {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.map((e) => ({ type: e.isDirectory() ? 'directory' : 'file', name: e.name }));
  },
};

function buildHarness(root) {
  const tools = new Map();
  const ctx = {
    get(name) {
      if (name === 'fs') return fsService;
      if (name === 'sandboxPolicy') return { workspaceRoot: root, resolve: () => ({}) };
      return undefined;
    },
    tools: { register(def) { tools.set(def.name, def); return () => {}; } },
    systemPrompt: { section() { return () => {}; } },
  };
  plugin.apply(ctx);
  const exec = { agent: { session: { header: { cwd: root } } } };
  const call = async (toolName, args) => {
    const def = tools.get(toolName);
    assert(def, `工具未注册：${toolName}`);
    const out = await def.execute(args, exec);
    return out.result;
  };
  return { tools, call };
}

const CLEAN = [
  '雨点砸在铁皮棚上，声音乱成一片。',
  '老陈把烟摁灭在鞋底，抬头看了看巷口。',
  '那盏路灯又坏了，一闪一闪，像有人在上头按开关。',
  '他拎起工具箱，往雨里走。',
  '巷子尽头停着一辆黑色面包车，车牌被泥糊住了。',
  '老陈蹲下去，伸手抹了一把。',
  '泥底下露出半个字，是个“京”字。',
].join('');

const root = await mkdtemp(path.join(tmpdir(), 'novel-tools-test-'));
const { tools, call } = buildHarness(root);

console.log('工具层集成测试\n');

await check('插件注册 7 个 novel_* 工具', async () => {
  const names = [...tools.keys()].sort();
  const expected = ['novel_archive', 'novel_briefing', 'novel_check', 'novel_import', 'novel_lint', 'novel_project', 'novel_scan_book'];
  assert(names.length === expected.length, `工具数应为 ${expected.length}，实际 ${names.length}：${names.join(',')}`);
  for (const n of expected) assert(names.includes(n), `缺少工具 ${n}`);
});

await check('初始化工程生成目录骨架', async () => {
  const out = await call('novel_project', { action: '初始化工程', title: '测试作品' });
  assert(out.includes('已初始化工程'), `返回异常：${out}`);
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert(readme.includes('测试作品'), 'README 未写入作品名');
  for (const f of ['伏笔清单.md', '时间线.md', '文风卡.md', '大纲/总纲.md', '设定集/世界观.md', '人物卡/_索引.md']) {
    const text = await readFile(path.join(root, f), 'utf8');
    assert(text.length > 0, `${f} 未生成`);
  }
});

await check('保存门禁：硬违规正文被拒收，不落盘', async () => {
  const out = await call('novel_project', {
    action: '保存章节', chapter_number: 1, chapter_title: '开端', content: '他推开门；屋里没人。',
  });
  assert(out.includes('保存被门禁拦截'), `应被门禁拦截，实际：${out.slice(0, 80)}`);
  const files = await readdir(path.join(root, '正文')).catch(() => []);
  assert(!files.some((f) => f.startsWith('第001章')), `正文目录不应出现第001章，实际：${files.join(',')}`);
});

await check('保存章节：干净正文落盘并带出软提示', async () => {
  const out = await call('novel_project', {
    action: '保存章节', chapter_number: 1, chapter_title: '开端', content: CLEAN,
  });
  assert(out.includes('已保存章节'), `应保存成功，实际：${out.slice(0, 120)}`);
  assert(out.includes('门禁通过'), '应报告门禁通过');
  const text = await readFile(path.join(root, '正文/第001章-开端.md'), 'utf8');
  assert(text === CLEAN, '落盘内容与传入正文不一致');
});

await check('写前材料：伏笔体检点名悬空超过 15 章的条目', async () => {
  await writeFile(path.join(root, '伏笔清单.md'), [
    '# 伏笔清单',
    '',
    '| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 玄铁令牌 | 第003章 | 出现两次 | — | 未回收 |',
    '| 老宅钥匙 | 第002章 | 一次 | 第010章 | 已回收 |',
  ].join('\n'), 'utf8');
  const out = await call('novel_briefing', { chapter_number: 20 });
  assert(out.includes('【伏笔体检】'), `应输出伏笔体检，实际：${out.slice(0, 200)}`);
  assert(out.includes('玄铁令牌'), '应点名超期伏笔玄铁令牌');
  assert(out.includes('已过 17 章'), '应算出悬空 17 章');
  assert(!out.includes('「老宅钥匙」第002章铺设'), '已回收的伏笔不应进超期名单');
  assert(out.includes('【材料覆盖】'), '应输出材料覆盖报告');
});

await check('写前材料：章节缺口时给出上一章结尾与文风卡', async () => {
  const out = await call('novel_briefing', { chapter_number: 2 });
  assert(out.includes('【上一章结尾'), '应带出上一章结尾');
  assert(out.includes('【文风卡】'), '应带出文风卡');
});

await check('进度统计：标出偏离 2000–4000 字的章节', async () => {
  const long = '雨点砸在铁皮棚上。'.repeat(300); // 约 3000 字
  await call('novel_project', { action: '保存章节', chapter_number: 2, chapter_title: '长章', content: long });
  const out = await call('novel_project', { action: '统计进度' });
  assert(out.includes('| 章节 | 字数 | 备注 |'), '表头应含备注列');
  assert(out.includes('偏短'), '第 1 章应标偏短');
  assert(out.includes('篇幅偏离默认区间'), '应给出篇幅分布汇总');
  assert(out.includes('总字数'), '应给出总字数');
});

await check('导入撞号保护：目标章号已有正文时整批拒收', async () => {
  const before = await readFile(path.join(root, '正文/第001章-开端.md'), 'utf8');
  let err = null;
  try {
    await call('novel_import', { text: '第1章 旧稿\n\n他把门推开，屋里空着。', chapter_number: 1 });
  } catch (e) { err = e; }
  assert(err, '撞号时应抛错');
  assert(err.message.includes('导入撞号'), `错误信息应说明撞号，实际：${err.message}`);
  const after = await readFile(path.join(root, '正文/第001章-开端.md'), 'utf8');
  assert(before === after, '撞号拒收后原正文不应被改动');
});

await check('导入撞号保护：force 可覆盖', async () => {
  const out = await call('novel_import', { text: '第1章 旧稿\n\n他把门推开，屋里空着。', chapter_number: 1, force: true });
  assert(out.includes('已导入 1 章'), `应导入成功，实际：${out.slice(0, 100)}`);
  assert(out.includes('覆盖'), '应报告覆盖了同名章节');
});

await check('导入：无撞号时按新序号续接落盘', async () => {
  const out = await call('novel_import', { text: '第9章 起风\n\n风从巷口灌进来。', chapter_number: 9 });
  assert(out.includes('第9章起'), `应报告起始章号，实际：${out.slice(0, 100)}`);
  const text = await readFile(path.join(root, '正文/第009章-起风.md'), 'utf8');
  assert(text.includes('风从巷口灌进来'), '正文内容未落盘');
});

await check('归档：表格格式不合格时拒收且不写入', async () => {
  let err = null;
  try {
    await call('novel_archive', {
      chapter_number: 1,
      archive_report: '本章交代了老陈进巷子找车，发现车牌被泥糊住，露出“京”字；老陈与司机发生对峙，暂时处于下风。',
      foreshadow_table: '伏笔 | 铺设位置 | 状态',
    });
  } catch (e) { err = e; }
  assert(err && err.message.includes('格式不合格'), `应拒收不合格表格，实际：${err && err.message}`);
});

await check('归档：三段更新写入伏笔清单/时间线/归档', async () => {
  const table = [
    '| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |',
    '| --- | --- | --- | --- | --- |',
    '| 京字车牌 | 第001章 | 待发酵 | — | 未回收 |',
  ].join('\n');
  const out = await call('novel_archive', {
    chapter_number: 1,
    chapter_title: '开端',
    archive_report: '①摘要：老陈进巷子找车，发现车牌被泥糊住。②人物：老陈——警觉提高。③设定：京字车牌。④遗留：司机身份未明。',
    foreshadow_table: table,
    timeline_rows: '| 当晚 | 老陈发现京字车牌 | 老陈 | 引出车牌来历 |',
  });
  assert(out.includes('归档落盘完成'), `应归档成功，实际：${out.slice(0, 120)}`);
  const fs2 = await readFile(path.join(root, '伏笔清单.md'), 'utf8');
  assert(fs2.includes('京字车牌'), '伏笔清单未更新');
  const tl = await readFile(path.join(root, '时间线.md'), 'utf8');
  assert(tl.includes('老陈发现京字车牌'), '时间线未追加');
  const arc = await readFile(path.join(root, '归档/第001章-开端-归档.md'), 'utf8');
  assert(arc.includes('①摘要'), '归档记录未落盘');
});

await check('归档：过短的占位报告被拒收', async () => {
  let err = null;
  try {
    await call('novel_archive', { chapter_number: 2, archive_report: '写完了。' });
  } catch (e) { err = e; }
  assert(err && err.message.includes('太短'), `应拒收占位报告，实际：${err && err.message}`);
});

await check('全书体检：选中章节并汇总工程材料', async () => {
  const out = await call('novel_scan_book', { scope: '最近章节', chapter_count: 3 });
  assert(out.includes('【正文章节】'), '应带出正文章节');
  assert(out.includes('【人物卡（工程材料）】'), '应带出人物卡');
  assert(out.includes('六个维度'), '应给出体检维度提示');
});

// ---------------- 汇总 ----------------
await rm(root, { recursive: true, force: true });
console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${pass} 项通过，${failures.length} 项失败`);
if (failures.length) {
  for (const f of failures) console.log(`  · ${f.name}: ${f.message}`);
  process.exit(1);
}
