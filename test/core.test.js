'use strict';

/* ============================================================
   核心逻辑测试（test/core.test.js）

   跑法：node --test   或   node test/core.test.js
   零依赖：用 Node 18+ 内置的 node:test。

   这些用例守的是「评分链路」——它出问题时不会报错，只会静默错：
   模型输出的 JSON 解析不了就整段显示原文、维度分缺一个总分就算错、
   字段名换一种写法就全变成「—」。所以每条用例都对应一个真实风险。
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../js/core.js');
const scenarios = require('../js/scenarios.js');

/* ---------------- 对话历史 → 文本 ---------------- */

test('对话记录：护士与对方分别映射成「护士：」「对方：」', () => {
  const transcript = core.buildTranscript([
    { role: 'assistant', content: '我在门口等了很久' },
    { role: 'user', content: '您好，我是您的责任护士' },
  ]);
  assert.equal(transcript, '对方：我在门口等了很久\n护士：您好，我是您的责任护士');
});

test('对话记录：空历史与非法入参不炸', () => {
  assert.equal(core.buildTranscript([]), '');
  assert.equal(core.buildTranscript(null), '');
  assert.equal(core.buildTranscript(undefined), '');
});

test('评分前置条件：至少要有一问一答', () => {
  assert.equal(core.canScore([]), false);
  assert.equal(core.canScore([{ role: 'assistant', content: '开场白' }]), false, '只有开场白不该允许评分');
  assert.equal(
    core.canScore([
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: '你好' },
    ]),
    true,
  );
});

/* ---------------- 提示词组装 ---------------- */

test('患者档案：拼成逐条清单，且明确要求不得编造', () => {
  const prompt = core.buildPatientProfilePrompt([
    ['姓名', '王阿姨'],
    ['年龄', '62 岁'],
  ]);
  assert.ok(prompt.includes('- 姓名：王阿姨'));
  assert.ok(prompt.includes('- 年龄：62 岁'));
  assert.ok(prompt.includes('不得前后矛盾、不得编造'));
  assert.equal(core.buildPatientProfilePrompt([]), '');
  assert.equal(core.buildPatientProfilePrompt(null), '');
});

test('患者 system：角色设定 + 档案 + 通用规则，三者都在且顺序固定', () => {
  const scenario = {
    system: '你是王阿姨。',
    patientInfo: [['姓名', '王阿姨']],
  };
  const system = core.buildPatientSystem(scenario);
  assert.ok(system.startsWith('你是王阿姨。'), '角色设定应在最前');
  assert.ok(system.indexOf('你是王阿姨。') < system.indexOf('你的基础信息'), '档案应在角色设定之后');
  assert.ok(system.includes('【通用说话方式'), '必须带上通用说话方式规则');
  assert.ok(system.includes('绝不承认是AI'), '必须带上「不承认是 AI」的铁规则');
});

test('评分 system：通用评分规则 + 本场景量表', () => {
  const system = core.buildScoringSystem({ scoring: '【维度】共情、告知' });
  assert.ok(system.includes('打分锚点'));
  assert.ok(system.includes('总分 = 四个维度得分之和 ÷ 4 × 20'));
  assert.ok(system.endsWith('【维度】共情、告知'));
});

test('评分 user：重试时会额外提醒只输出 JSON', () => {
  const first = core.buildScoringUser('护士：你好');
  const retry = core.buildScoringUser('护士：你好', true);
  assert.ok(first.includes('对话记录如下：'));
  assert.equal(first.includes('上次没有输出合法'), false);
  assert.ok(retry.includes('上次没有输出合法'));
});

test('对话消息数组：system 在最前，历史顺序不变', () => {
  const scenario = { system: '角色', patientInfo: [] };
  const messages = core.buildChatMessages(scenario, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '嗯' },
  ]);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, '你好');
  assert.equal(messages[2].content, '嗯');
});

/* ---------------- 模型输出解析 ---------------- */

test('解析 JSON：裸对象、代码块包裹、前后带解释都能解析', () => {
  assert.deepEqual(core.parseJson('{"总分":90}'), { 总分: 90 });
  assert.deepEqual(core.parseJson('```json\n{"总分":90}\n```'), { 总分: 90 });
  assert.deepEqual(core.parseJson('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(core.parseJson('这是评分结果：{"a":1} 请查收'), { a: 1 });
});

test('解析 JSON：解析不了时返回 null（交给调用方重试），不抛错', () => {
  assert.equal(core.parseJson('完全没有 JSON'), null);
  assert.equal(core.parseJson('{坏的 json}'), null);
  assert.equal(core.parseJson(''), null);
  assert.equal(core.parseJson(null), null);
  assert.equal(core.parseJson('[1,2,3]'), null, '数组不是合法评分结果');
  assert.deepEqual(core.parseJson('{}'), {}, '空对象是合法 JSON，但没有维度，由归一化处理');
});

/* ---------------- 分数归一化 ---------------- */

test('维度分归一化：非数字、越界、空值都视为无有效分', () => {
  assert.equal(core.normalizeScore(4), 4);
  assert.equal(core.normalizeScore('3.5'), 3.5);
  assert.equal(core.normalizeScore(0), 0, '0 分是有效分，不能被当成空值');
  assert.equal(core.normalizeScore(5), 5);
  assert.equal(core.normalizeScore(6), null);
  assert.equal(core.normalizeScore(-1), null);
  assert.equal(core.normalizeScore('abc'), null);
  assert.equal(core.normalizeScore(''), null);
  assert.equal(core.normalizeScore(null), null);
});

test('总分换算：平均分 × 20，四舍五入取整', () => {
  assert.equal(core.computeTotal([5, 5, 5, 5]), 100);
  assert.equal(core.computeTotal([4, 3, 4, 3]), 70);
  assert.equal(core.computeTotal([4, 4, 3, 3]), 70);
  assert.equal(core.computeTotal([3.5, 3.5, 3.5, 3.5]), 70);
  assert.equal(core.computeTotal([2.4, 2.4, 2.4, 2.4]), 48, '2.4×20=48');
  assert.equal(core.computeTotal([2.46, 2.46, 2.46, 2.46]), 49, '四舍五入到 49');
});

test('总分换算：任一维度缺分就不给总分（避免虚高）', () => {
  assert.equal(core.computeTotal([5, 5, null, 5]), null);
  assert.equal(core.computeTotal([]), null);
  assert.equal(core.computeTotal(null), null);
});

test('字段兼容：中英文字段名都能取到', () => {
  assert.equal(core.pickField({ 得分: 4, score: 3 }, ['得分', 'score']), 4);
  assert.equal(core.pickField({ score: 3 }, ['得分', 'score']), 3);
  assert.equal(core.pickField({ 得分: '' }, ['得分', 'score'], '默认'), '默认', '空字符串视为没有值');
  assert.equal(core.pickField(null, ['得分'], '默认'), '默认');
});

test('结果归一化：标准中文输出', () => {
  const result = core.normalizeScoreResult({
    各维度: {
      共情: { 得分: 4, 说明: '做得较好', 依据: '我理解您担心' },
      告知: { 得分: 3, 说明: '信息不全', 依据: '需要做检查' },
      倾听: { 得分: 5, 说明: '完整', 依据: '您慢慢说' },
      确认: { 得分: 4, 说明: '不错', 依据: '我复述一下' },
    },
    遗漏的关键信息: ['费用问题'],
    做得好的地方: ['语气温和'],
    改进建议: ['追问担心的事'],
    总分: 999,
  });
  assert.equal(result.ok, true);
  assert.equal(result.dimensions.length, 4);
  assert.equal(result.total, 80, '总分必须由维度分换算，忽略模型自己写的 999');
  assert.equal(result.dimensions[0].score, 4);
  assert.equal(result.dimensions[0].note, '做得较好');
  assert.equal(result.dimensions[0].evidence, '我理解您担心');
  assert.deepEqual(result.missed, ['费用问题']);
  assert.deepEqual(result.strengths, ['语气温和']);
  assert.deepEqual(result.suggestions, ['追问担心的事']);
});

test('结果归一化：英文/别名输出也能认（dimensions / score / note / evidence）', () => {
  const result = core.normalizeScoreResult({
    dimensions: { empathy: { score: 4, note: 'ok', evidence: 'quote' } },
    strengths: '只有一个字符串',
    suggestions: ['改进 A', '改进 B'],
  });
  assert.equal(result.dimensions[0].score, 4);
  assert.equal(result.dimensions[0].note, 'ok');
  assert.deepEqual(result.strengths, ['只有一个字符串'], '字符串也要能变成列表');
  assert.deepEqual(result.suggestions, ['改进 A', '改进 B']);
});

test('结果归一化：只有部分维度有效分时，总分退回模型给的值', () => {
  const result = core.normalizeScoreResult({
    各维度: { 共情: { 得分: 4 }, 告知: { 得分: '未知' } },
    总分: 75,
  });
  assert.equal(result.total, 75, '缺维度分时应退回模型写的总分');
  assert.equal(result.dimensions[1].score, null);
});

test('结果归一化：空输入不炸，返回 ok=false', () => {
  assert.equal(core.normalizeScoreResult(null).ok, false);
  assert.equal(core.normalizeScoreResult(undefined).ok, false);
  assert.equal(core.normalizeScoreResult('字符串').ok, false);
  assert.equal(core.normalizeScoreResult({}).ok, true, '空对象是合法 JSON，只是没有维度');
  assert.equal(core.normalizeScoreResult({}).total, null);
});

/* ---------------- 场景库 ---------------- */

test('场景库：12 个场景、4 个分类，且全部通过结构自检', () => {
  const report = core.validateScenarios(scenarios);
  assert.equal(report.total, 12);
  assert.deepEqual(report.categories, ['健康宣教', '心理疏导', '情绪与冲突', '复杂情况']);
  assert.deepEqual(report.problems, [], `场景数据有问题：\n${report.problems.join('\n')}`);
});

test('场景库：每个场景都有开场白与评分量表，且量表要求 JSON 输出', () => {
  scenarios.forEach((scenario) => {
    assert.ok(scenario.opening && scenario.opening.length > 0, `${scenario.title} 缺少开场白`);
    assert.ok(scenario.scoring.includes('JSON'), `${scenario.title} 的评分量表没要求 JSON`);
    assert.ok(Array.isArray(scenario.patientInfo), `${scenario.title} 缺少患者信息卡`);
    assert.ok(scenario.nurseRef && Array.isArray(scenario.nurseRef.focus), `${scenario.title} 缺少训练参考`);
  });
});

test('场景库自检：能发现缺字段与重复 id', () => {
  const broken = core.validateScenarios([
    { id: 'a', category: '类', title: '正常', label: '患者', opening: '你…', system: 'x', scoring: 'JSON' },
    { id: 'a', category: '类', title: '', label: '患者', opening: '你…', system: 'x', scoring: '没有说明格式' },
  ]);
  assert.ok(broken.problems.some((p) => p.includes('缺少字段 title')));
  assert.ok(broken.problems.some((p) => p.includes('id 重复')));
  assert.ok(broken.problems.some((p) => p.includes('没有说明 JSON') || p.includes('JSON 输出格式')));
});

test('分组：按分类归拢并保持原顺序', () => {
  const groups = core.groupByCategory(scenarios);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].category, '健康宣教');
  assert.equal(groups[0].indexes.length, 3);
  const total = groups.reduce((sum, group) => sum + group.indexes.length, 0);
  assert.equal(total, 12, '分组不能丢场景');
});

test('取场景：越界或非法下标退回第一个，不返回 undefined', () => {
  assert.equal(core.getScenario(scenarios, 0).title, scenarios[0].title);
  assert.equal(core.getScenario(scenarios, 11).title, scenarios[11].title);
  assert.equal(core.getScenario(scenarios, 99).title, scenarios[0].title);
  assert.equal(core.getScenario(scenarios, 'abc').title, scenarios[0].title);
  assert.equal(core.getScenario([], 0), null);
});

/* ---------------- 常量 ---------------- */

test('常量：默认接口与模型可被界面覆盖', () => {
  assert.equal(core.DEFAULT_BASE, 'https://api.deepseek.com');
  assert.equal(core.DEFAULT_MODEL, 'deepseek-chat');
  assert.ok(core.PATIENT_RULES.includes('绝不承认是AI'));
  assert.ok(core.SCORING_WRAPPER.includes('0分 = 完全未涉及'));
});
