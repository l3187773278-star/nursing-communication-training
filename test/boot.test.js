'use strict';

/* ============================================================
   启动冒烟测试（test/boot.test.js）

   为什么需要它：核心逻辑测试只证明「纯函数是对的」，证明不了
   「页面能起来、按钮能点、评分能显示」。而这一层出问题时表现是全白：
   某个函数名写错、某个元素 id 对不上、某个模块忘了加载——
   现象都是「什么都没有」，且不会告诉你原因。

   做法：用最小假 DOM 依次加载 4 个脚本，然后像真人一样操作它：
   断言下拉框按分类生成、开场白可见、发送时带着 system 提示词请求接口、
   评分结果能渲染出维度与总分、模型输出里的 HTML 被当文本而不是标签。

   ⚠️ 假 DOM 必须建在测试所在的 realm（不要在 vm 沙箱里造好了再传出来），
   否则跨 realm 包装会让「脚本写入的元素」和「测试读取的元素」不是同一个对象。
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = ['js/scenarios.js', 'js/core.js', 'js/ui.js', 'js/boot.js'];

/* ---------------- 假 DOM ---------------- */

/** 元素替身：维护父子关系与 class，便于遍历断言。 */
function makeElement(id, tag) {
  const classes = new Set();
  const element = {
    id: id || '',
    tagName: (tag || 'div').toUpperCase(),
    textContent: '',
    value: '',
    disabled: false,
    open: false,
    style: {},
    children: [],
    parentNode: null,
    className: '',
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n);
        else classes.delete(n);
        return on;
      },
    },
    appendChild(child) {
      child.parentNode = element;
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((item) => item !== child);
      return child;
    },
    addEventListener(type, handler) {
      (element._listeners[type] = element._listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    contains: () => false,
    scrollIntoView() {},
    _listeners: {},
    /** 测试用：递归收集可读文本（模拟 textContent 的聚合行为）。 */
    _text() {
      const own = element.textContent || '';
      return own + element.children.map((child) => child._text()).join(' ');
    },
    /** 测试用：递归收集所有后代元素。 */
    _all() {
      return element.children.reduce((acc, child) => acc.concat(child, child._all()), []);
    },
  };
  // className 与 classList 保持同步，便于按类名找元素
  Object.defineProperty(element, 'className', {
    get: () => [...classes].join(' '),
    set: (value) => {
      classes.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((n) => classes.add(n));
    },
  });
  // innerHTML 在真实 DOM 里赋值会整体替换子节点。这里至少要还原「清空」语义：
  // 否则 ui.clear() 之后测试仍能看到旧子节点，得出的结论会和浏览器相反
  // ——「切换场景后对话没清空」就是这么误报出来的。
  let html = '';
  Object.defineProperty(element, 'innerHTML', {
    get: () => html,
    set: (value) => {
      html = String(value);
      if (html === '') element.children = [];
      else element._innerHTMLWrites = (element._innerHTMLWrites || 0) + 1;
    },
  });

  element.scrollHeight = 0;
  element.scrollTop = 0;
  return element;
}

/** 按 index.html 里声明的 id 建一套元素索引。 */
function makeDocument(htmlIds) {
  const byId = new Map();
  const documentListeners = {};

  const getElement = (id) => {
    if (!byId.has(id)) byId.set(id, makeElement(id));
    return byId.get(id);
  };
  htmlIds.forEach(getElement);

  return {
    body: makeElement('body'),
    getElementById: (id) => getElement(id),
    querySelector: (selector) => {
      if (selector === 'details.settings') return getElement('__settings__');
      return makeElement('__stub__');
    },
    querySelectorAll: () => [],
    createElement: (tag) => makeElement('', tag),
    addEventListener(type, handler) {
      (documentListeners[type] = documentListeners[type] || []).push(handler);
    },
    _element: (id) => getElement(id),
    _fire(type, event) {
      (documentListeners[type] || []).forEach((handler) => handler(event));
    },
    _hasListener: (type) => (documentListeners[type] || []).length > 0,
  };
}

/* ---------------- 加载应用 ---------------- */

/**
 * 加载整个应用。
 * @param {{settings?: Object|null, fetchImpl?: Function}} [options]
 * @returns {{VP: Object, document: Object, store: Map, requests: Array, logs: string[]}}
 */
function loadApp(options = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlIds = [...html.matchAll(/id="([A-Za-z][\w-]*)"/g)].map((m) => m[1]);

  const document = makeDocument(htmlIds);
  const store = new Map();
  // 默认给一份可用的设置：绝大多数用例关心的是「填好 Key 之后的行为」，
  // 只有专门测缺 Key 的用例才显式传 settings 覆盖。
  const settings =
    options.settings === null
      ? null
      : options.settings || { apiKey: 'sk-test', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' };
  if (settings) store.set('vp_settings', JSON.stringify(settings));

  const requests = [];
  const logs = [];
  const timers = [];

  const localStorageFake = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };

  /** 默认的假接口：永远成功返回一句患者回应。 */
  const defaultFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: '（患者回应）' }),
  });

  const respond = options.fetchImpl || defaultFetch;
  // 不论用哪个实现，都先记一笔请求：断言要看的是「应用到底发了什么」，
  // 而不是「假接口被调用了几次」。之前自定义 fetchImpl 直接替换了整个实现，
  // 于是「对话 1 次 + 评分 2 次重试」这条断言看到的是 0 次。
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return respond(url, init);
  };

  const window = {
    document,
    location: { protocol: 'http:', hostname: 'localhost', href: 'http://localhost:3000/' },
    navigator: {},
    localStorage: localStorageFake,
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: (...args) => logs.push(`warn: ${args.join(' ')}`),
      error: (...args) => logs.push(`error: ${args.join(' ')}`),
    },
    alert: (message) => logs.push(`alert: ${message}`),
    setTimeout: (fn) => {
      timers.push(fn);
      return 0;
    },
    clearTimeout() {},
    fetch: fetchImpl,
  };

  const context = vm.createContext({});
  Object.assign(context, {
    window,
    document,
    location: window.location,
    navigator: window.navigator,
    localStorage: localStorageFake,
    console: window.console,
    alert: window.alert,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    fetch: window.fetch,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Math,
    Date,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
  });
  context.window.window = window;

  SCRIPTS.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      vm.runInContext(source, context, { filename: file });
    } catch (err) {
      err.message = `加载 ${file} 时抛错：${err.message}`;
      throw err;
    }
  });

  return { VP: window.VP, document, store, requests, logs, runTimers: () => timers.splice(0).forEach((fn) => fn()) };
}

/* ---------------- 启动 ---------------- */

test('启动：4 个脚本能全部加载执行，场景库自检通过', () => {
  const { VP, logs } = loadApp();
  assert.ok(VP, 'window.VP 未挂载');
  assert.ok(VP.boot, 'boot.js 未执行');
  assert.ok(VP.ui, 'ui.js 未挂载');
  assert.ok(VP.state, 'state 未初始化');
  assert.equal(
    logs.filter((line) => line.startsWith('error:')).length,
    0,
    `启动期间出现错误：\n${logs.join('\n')}`,
  );
  assert.ok(
    logs.some((line) => line.includes('场景库自检通过')),
    '应输出自检结果，便于确认数据完整',
  );
});

test('启动：下拉框按分类生成四组，共 12 个场景', () => {
  const { document } = loadApp();
  const select = document._element('scenarioSelect');
  assert.equal(select.children.length, 4, '应有 4 个分类分组');

  const labels = select.children.map((group) => group.label);
  assert.deepEqual(labels, ['健康宣教', '心理疏导', '情绪与冲突', '复杂情况']);

  const options = select.children.reduce((acc, group) => acc.concat(group.children), []);
  assert.equal(options.length, 12, '共 12 个场景');
  assert.ok(options.every((option) => option.textContent), '每个选项都要有标题');
  assert.equal(options[0].value, '0');
  assert.equal(options[11].value, '11');
});

test('启动：首屏显示场景标题、开场白与操作提示', () => {
  const { document } = loadApp();
  assert.ok(document._element('scenarioTitle').textContent, '场景标题为空');
  assert.ok(document._element('hintLine').textContent, '操作提示为空');

  const chat = document._element('chat');
  assert.equal(chat.children.length, 1, '应只有一条开场白气泡');
  const bubble = chat.children[0];
  assert.ok(bubble.className.includes('patient'), '开场白应来自患者侧');
  assert.ok(bubble._text().length > 0, '开场白内容为空');
  assert.ok(bubble._text().includes('对方') || bubble._text().includes('患者'), '气泡要有角色标签');
});

test('启动：患者信息卡与训练参考都渲染出来了', () => {
  const { document } = loadApp();
  const table = document._element('patientInfoTable');
  assert.ok(table.children.length > 0, '患者信息表为空');
  assert.ok(table.children[0].children.length === 2, '每行应是「字段 / 值」两列');

  const ref = document._element('nurseRefBody');
  assert.ok(ref._text().includes('🎯'), '训练参考应包含任务');
  assert.ok(ref._text().includes('要点清单'), '训练参考应包含要点清单');
});

/* ---------------- 交互：发送 ---------------- */

test('交互：发送消息会带上 system 提示词（含患者档案与通用规则）', async () => {
  const { VP, document, requests } = loadApp();
  document._element('input').value = '阿姨您好，我是您的责任护士';

  await VP.boot.send();

  assert.equal(requests.length, 1, '应发出一次请求');
  const payload = requests[0].body;
  assert.ok(payload.messages, '请求体缺少 messages');

  const system = payload.messages[0];
  assert.equal(system.role, 'system');
  assert.ok(system.content.includes('你的基础信息'), 'system 应包含患者档案');
  assert.ok(system.content.includes('绝不承认是AI'), 'system 应包含通用铁规则');

  const last = payload.messages[payload.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, '阿姨您好，我是您的责任护士');
  assert.equal(payload.temperature, 0.8, '对话温度应为 0.8');
});

test('交互：发送后对话区同时出现护士与患者两条气泡，输入框清空', async () => {
  const { VP, document } = loadApp();
  const input = document._element('input');
  input.value = '您今天感觉怎么样？';

  await VP.boot.send();

  const chat = document._element('chat');
  assert.equal(chat.children.length, 3, '开场白 + 护士发言 + 患者回应');
  assert.ok(chat.children[1].className.includes('user'));
  assert.ok(chat.children[2].className.includes('patient'));
  assert.equal(input.value, '', '发送后应清空输入框');
});

test('交互：空消息不发请求', async () => {
  const { VP, document, requests } = loadApp();
  document._element('input').value = '   ';
  await VP.boot.send();
  assert.equal(requests.length, 0);
});

test('交互：接口报错时错误信息显示在对话里，而不是静默失败', async () => {
  const { VP, document } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: 'Key 无效' }) }),
  });
  document._element('input').value = '你好';
  await VP.boot.send();

  const chat = document._element('chat');
  assert.ok(chat._text().includes('Key 无效'), '应把接口错误显示出来');
  assert.equal(VP.state.busy, false, '出错后要恢复可操作状态');
});

test('交互：没有填 API Key 时给出明确提示', async () => {
  const { VP, document, requests } = loadApp({ settings: null });
  document._element('input').value = '你好';
  await VP.boot.send();
  assert.equal(requests.length, 0, '没有 Key 就不该发请求');
  assert.ok(document._element('chat')._text().includes('API Key'));
});

/* ---------------- 交互：评分 ---------------- */

const GOOD_SCORE = JSON.stringify({
  各维度: {
    共情与尊重: { 得分: 4, 说明: '做得较好', 依据: '我理解您担心' },
    信息告知: { 得分: 3, 说明: '不够完整', 依据: '需要做个检查' },
    倾听与回应: { 得分: 4, 说明: '有回应', 依据: '您慢慢说' },
    确认与闭环: { 得分: 3, 说明: '略有欠缺', 依据: '我复述一下' },
  },
  遗漏的关键信息: ['费用问题'],
  做得好的地方: ['语气温和'],
  改进建议: ['追问担心的事'],
});

test('评分：能渲染出总分、四个维度与三张清单', async () => {
  const { VP, document } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: GOOD_SCORE }) }),
  });

  document._element('input').value = '阿姨您好';
  await VP.boot.send();
  await VP.boot.score();

  const panel = document._element('scorePanel');
  assert.equal(panel.style.display, 'block', '评分面板应显示');

  const text = document._element('scoreBody')._text();
  assert.ok(text.includes('总分：70 / 100'), `总分应为 70（(4+3+4+3)/4×20），实际：${text.slice(0, 80)}`);
  assert.ok(text.includes('共情与尊重'), '应显示维度名');
  assert.ok(text.includes('4 / 5'), '应显示维度分');
  assert.ok(text.includes('依据：'), '应显示评分依据');
  assert.ok(text.includes('遗漏的要点') && text.includes('改进建议'), '应显示清单');
});

test('评分：模型输出被代码块包裹时也能解析', async () => {
  const { VP, document } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: '```json\n' + GOOD_SCORE + '\n```' }) }),
  });
  document._element('input').value = '你好';
  await VP.boot.send();
  await VP.boot.score();
  assert.ok(document._element('scoreBody')._text().includes('总分：70'), '代码块包裹的 JSON 应能解析');
});

test('评分：第一次不是合法 JSON 时会自动重试一次', async () => {
  let call = 0;
  const { VP, document, requests } = loadApp({
    fetchImpl: async () => {
      call++;
      return { ok: true, status: 200, json: async () => ({ content: call <= 2 ? '这不是 JSON' : GOOD_SCORE }) };
    },
  });
  document._element('input').value = '你好';
  await VP.boot.send();
  await VP.boot.score();

  assert.equal(requests.length, 3, '对话 1 次 + 评分 2 次（含重试）');
  assert.ok(requests[2].body.messages[1].content.includes('上次没有输出合法'), '重试时应提醒模型只输出 JSON');
  assert.ok(document._element('scoreBody')._text().includes('总分：70'), '重试后应拿到有效评分');
});

test('评分：两次都解析不了时原样展示模型输出，而不是白屏', async () => {
  const { VP, document } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: '模型说了一堆话' }) }),
  });
  document._element('input').value = '你好';
  await VP.boot.send();
  await VP.boot.score();

  const body = document._element('scoreBody');
  assert.ok(body._text().includes('模型说了一堆话'), '解析失败时应原样显示模型输出');
  assert.ok(body.children.length > 0, '不能让面板空着');
});

test('评分：还没对话时提示先沟通，且不发请求', async () => {
  const { VP, document, requests, logs } = loadApp();
  await VP.boot.score();
  assert.equal(requests.length, 0, '没有对话就不该请求评分');
  assert.ok(logs.some((line) => line.includes('先进行一段沟通对话')), '应给出提示');
});

test('评分：模型输出里的 HTML 被当成文本，不会作为标签执行', async () => {
  const malicious = JSON.stringify({
    各维度: { 共情: { 得分: 4, 说明: '<img src=x onerror=alert(1)>', 依据: 'ok' } },
  });
  const { VP, document } = loadApp({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ content: malicious }) }),
  });
  document._element('input').value = '你好';
  await VP.boot.send();
  await VP.boot.score();

  const body = document._element('scoreBody');
  // 渲染用 textContent：标签应原样留在文本里，且没有任何元素被创建成 img
  assert.ok(body._text().includes('<img src=x onerror=alert(1)>'), '恶意内容应作为纯文本显示');
  assert.equal(
    body._all().filter((node) => node.tagName === 'IMG').length,
    0,
    '不应创建出 img 元素',
  );
});

/* ---------------- 场景切换与设置 ---------------- */

test('切换场景：重置对话、换标题与开场白', async () => {
  const { VP, document } = loadApp();
  document._element('input').value = '你好';
  await VP.boot.send();
  assert.equal(document._element('chat').children.length, 3, '切换前应有 3 条');

  VP.boot.switchScenario('5');

  const chat = document._element('chat');
  assert.equal(chat.children.length, 1, '切换后应只剩新场景的开场白');
  assert.equal(VP.state.current, 5);
  assert.equal(document._element('scenarioSelect').value, '5');
  assert.ok(document._element('scenarioTitle').textContent, '应更新场景标题');
});

test('切换场景：非法下标退回第一个场景，不白屏', () => {
  const { VP, document } = loadApp();
  VP.boot.switchScenario('999');
  assert.equal(VP.state.current, 0);
  assert.ok(document._element('scenarioTitle').textContent);
});

test('设置：保存后写入本地存储，还原时回填表单', () => {
  const { VP, document, store } = loadApp();
  document._element('apiKey').value = 'sk-test-123';
  document._element('baseURL').value = 'https://example.com/v1';
  document._element('model').value = 'my-model';

  VP.boot.saveSettings();
  const saved = JSON.parse(store.get('vp_settings'));
  assert.equal(saved.apiKey, 'sk-test-123');
  assert.equal(saved.baseURL, 'https://example.com/v1');
  assert.equal(saved.model, 'my-model');

  // 清空表单后还原，应重新填回
  document._element('apiKey').value = '';
  VP.boot.restoreSettings();
  assert.equal(document._element('apiKey').value, 'sk-test-123', '还原应把已保存的 Key 填回');
});

test('设置：未填地址与模型时用默认值', () => {
  const { VP, document, store } = loadApp();
  document._element('apiKey').value = 'sk-x';
  document._element('baseURL').value = '';
  document._element('model').value = '';
  VP.boot.saveSettings();

  const stored = JSON.parse(store.get('vp_settings'));
  assert.equal(stored.baseURL, 'https://api.deepseek.com');
  assert.equal(stored.model, 'deepseek-chat');
});

test('设置：本地存储不可用时不抛错，只提示（file:// 常见）', () => {
  const { VP, document, logs, store } = loadApp();
  // 模拟浏览器禁用存储：写入即抛错
  store.set = () => {
    throw new Error('QuotaExceededError');
  };
  document._element('apiKey').value = 'sk-x';

  assert.doesNotThrow(() => VP.boot.saveSettings(), '存储失败不该把界面卡死');

  // 提示要落在用户看得见的状态条上；控制台那条只是给排查用的旁证
  const status = document._element('status').textContent;
  assert.ok(status.includes('保存失败'), `状态条应显示保存失败，实际是「${status}」`);
  assert.ok(logs.some((line) => line.startsWith('warn:')), '同时应在控制台留下记录，便于排查');
});

/* ---------------- 事件接线 ---------------- */

test('接线：页面没有行内 onclick，全部走 data-action 委托', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.equal(/onclick=/.test(html), false, 'index.html 不应再有行内 onclick');

  const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(actions.length >= 4, `data-action 数量异常：${actions.length}`);

  // boot.js 的 ACTIONS 表用对象简写（如 `score,`），逐个确认动作名被登记
  const boot = fs.readFileSync(path.join(ROOT, 'js/boot.js'), 'utf8');
  const table = boot.slice(boot.indexOf('const ACTIONS = {'), boot.indexOf('};', boot.indexOf('const ACTIONS = {')));
  actions.forEach((action) => {
    const handled = new RegExp(`['"]?${action}['"]?\\s*[:,]`).test(table);
    assert.ok(handled, `boot.js 的 ACTIONS 里没有登记动作 ${action}`);
  });
});

test('接线：点击委托已注册（不然所有按钮都是死的）', () => {
  const { document } = loadApp();
  assert.ok(document._hasListener('click'), 'document 上应注册点击监听');
});

test('接线：界面引用的每个 #id 都存在于 index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const referenced = new Set();
  SCRIPTS.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    [...source.matchAll(/\$\(\s*'([A-Za-z][\w-]*)'\s*\)/g)].forEach((m) => referenced.add(m[1]));
  });

  const missing = [...referenced].filter((id) => !declared.has(id));
  assert.deepEqual(missing, [], `代码引用了不存在的 id：${missing.join(', ')}`);
  assert.ok(referenced.size >= 10, `提取到的 id 太少（${referenced.size}），检查正则`);
});

test('接线：index.html 按依赖顺序加载模块', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const positions = SCRIPTS.map((file) => {
    const index = html.indexOf(`src="${file}"`);
    assert.ok(index > -1, `index.html 没有引入 ${file}`);
    return index;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '脚本顺序与依赖不一致');
  assert.ok(html.indexOf('src="js/scenarios.js"') < html.indexOf('src="js/core.js"'), '数据要在逻辑之前');
  assert.ok(html.indexOf('src="js/ui.js"') < html.indexOf('src="js/boot.js"'), 'boot 必须最后');
});

test('约定：innerHTML 只用来清空，不用来拼内容', () => {
  const offenders = [];
  SCRIPTS.forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (!/\.innerHTML\s*=/.test(line)) return;
      if (/\.innerHTML\s*=\s*(''|"")\s*;?\s*$/.test(line)) return;
      offenders.push(`${file}:${index + 1}  ${line.trim()}`);
    });
  });
  assert.deepEqual(
    offenders,
    [],
    `对话与评分内容都来自模型输出，拼进 innerHTML 有注入风险：\n${offenders.join('\n')}`,
  );
});
