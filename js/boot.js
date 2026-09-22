'use strict';

/* ============================================================
   应用装配与事件接线（boot.js）

   职责：状态、事件委托、网络调用、启动自检。

   两个刻意的设计：

   1. 用事件委托而不是行内 onclick。
      原版靠 onclick="send()" 调用全局函数，一旦把逻辑收进模块就会全部失效；
      这里统一改成 data-action 属性 + 一个 document 级监听器，
      想知道「点这个按钮会发生什么」只看 handleAction 的分支即可。

   2. 自适应接口地址：本地服务直连、静态部署也直连。
      - 由 server.js 提供页面时（http://localhost:3000）：走 /api/chat，
        由本地服务转发，规避浏览器跨域；
      - 部署到 GitHub Pages 这类纯静态环境时：直接请求模型服务商的
        OpenAI 兼容接口（DeepSeek 支持浏览器直连）。
      API Key 始终只存在使用者自己的浏览器里，不上传任何第三方。
   ============================================================ */

window.VP = window.VP || {};

(function (VP) {
  const core = window.VPCore;
  const ui = VP.ui;
  const { $ } = ui;

  const SETTINGS_KEY = 'vp_settings';

  /** 应用状态：当前场景、对话历史、忙碌标记。 */
  VP.state = {
    current: 0,
    chatHistory: [],
    busy: false,
  };

  const scenarios = () => window.SCENARIOS || [];

  /* ---------------- 设置持久化 ---------------- */

  /**
   * 读取本地设置。存储不可用（如 file:// 下被浏览器限制）时返回空对象，
   * 而不是抛错把界面卡死。
   * @returns {Object}
   */
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch (err) {
      console.warn('[boot] 读取设置失败', err);
      return {};
    }
  }

  /** 保存设置到本机浏览器。 */
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(ui.readSettings()));
      ui.flashStatus('设置已保存');
    } catch (err) {
      console.warn('[boot] 保存设置失败', err);
      ui.flashStatus('保存失败：浏览器不允许存储');
    }
  }

  /** 把已保存的设置回填到表单。 */
  function restoreSettings() {
    ui.fillSettings(loadSettings());
    ui.flashStatus('设置已还原');
  }

  /* ---------------- 网络 ---------------- */

  /**
   * 调一次对话接口。
   * @param {Array<{role: string, content: string}>} messages
   * @param {number} temperature
   * @returns {Promise<string>} 模型返回的正文
   */
  async function callChat(messages, temperature) {
    const settings = ui.readSettings();
    if (!settings.apiKey) throw new Error('请先点右上角「⚙ 设置」填写 API Key');

    const useLocalProxy = location.protocol === 'http:' || location.protocol === 'https:';
    const endpoint = useLocalProxy ? '/api/chat' : `${settings.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const payload = useLocalProxy
      ? {
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          messages,
          temperature,
        }
      : {
          model: settings.model,
          messages,
          temperature,
          stream: false,
        };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: useLocalProxy
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);
    if (!data) throw new Error('接口返回不是合法 JSON');

    // 本地代理：{ error } / { content }
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    if (typeof data.content === 'string') return data.content;

    // 直连模型服务商：OpenAI 兼容结构
    const choice = data.choices && data.choices[0];
    if (choice && choice.message && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    throw new Error('接口返回内容为空');
  }

  /* ---------------- 对话与评分 ---------------- */

  /** 发送一条护士发言，并把患者的回应追加到对话区。 */
  async function send() {
    if (VP.state.busy) return;
    const input = $('input');
    const text = input ? input.value.trim() : '';
    if (!text) return;

    input.value = '';
    const scenario = core.getScenario(scenarios(), VP.state.current);
    ui.addBubble('user', text, scenario.label);
    VP.state.chatHistory.push({ role: 'user', content: text });
    ui.setBusy(true, '对方正在回应…');

    try {
      const reply = await callChat(core.buildChatMessages(scenario, VP.state.chatHistory), 0.8);
      VP.state.chatHistory.push({ role: 'assistant', content: reply });
      ui.addBubble('patient', reply, scenario.label);
    } catch (err) {
      ui.addBubble('patient', `（出错了：${err.message}）`, scenario.label);
    } finally {
      ui.setBusy(false);
    }
  }

  /** 结束沟通并请求评分；模型没给合法 JSON 时自动重试一次。 */
  async function score() {
    if (VP.state.busy) return;
    if (!core.canScore(VP.state.chatHistory)) {
      alert('请先进行一段沟通对话再评分');
      return;
    }

    const scenario = core.getScenario(scenarios(), VP.state.current);
    const transcript = core.buildTranscript(VP.state.chatHistory);
    ui.setBusy(true, '正在评分…');

    try {
      const system = core.buildScoringSystem(scenario);
      let content = await callChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: core.buildScoringUser(transcript, false) },
        ],
        0,
      );
      let parsed = core.parseJson(content);

      if (!parsed) {
        content = await callChat(
          [
            { role: 'system', content: system },
            { role: 'user', content: core.buildScoringUser(transcript, true) },
          ],
          0,
        );
        parsed = core.parseJson(content);
      }

      ui.renderScore(parsed, content);
      const panel = $('scorePanel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      ui.renderScore(null, `评分失败：${err.message}`);
    } finally {
      ui.setBusy(false);
    }
  }

  /**
   * 切换场景并重置对话。
   * 下标越界或非法时退回第一个场景——下拉框的值理论上总是合法的，
   * 但切换时若场景库被改动过（少了一个场景），没有兜底就会白屏。
   * @param {string|number} value
   */
  function switchScenario(value) {
    const index = parseInt(value, 10);
    const list = scenarios();
    VP.state.current = Number.isFinite(index) && index >= 0 && index < list.length ? index : 0;
    reset();
  }

  /** 重置到当前场景的开场白。 */
  function reset() {
    const scenario = core.getScenario(scenarios(), VP.state.current);
    if (!scenario) {
      console.error('[boot] 场景库为空，无法开始训练');
      return;
    }
    VP.state.chatHistory = [];
    ui.clearChat();
    ui.hideScorePanel();

    const title = $('scenarioTitle');
    if (title) title.textContent = scenario.title;
    const hint = $('hintLine');
    if (hint) hint.textContent = scenario.hint || '';
    const select = $('scenarioSelect');
    if (select) select.value = String(VP.state.current);

    ui.renderBrief(scenario);
    VP.state.chatHistory.push({ role: 'assistant', content: scenario.opening });
    ui.addBubble('patient', scenario.opening, scenario.label);
    ui.setBusy(false);
  }

  /* ---------------- 事件接线 ---------------- */

  /** 按钮动作 → 处理函数。 */
  const ACTIONS = {
    'save-settings': saveSettings,
    'restore-settings': restoreSettings,
    score,
    reset,
    send,
  };

  /**
   * 分发一次点击动作。
   * @param {string} action
   */
  function handleAction(action) {
    const handler = ACTIONS[action];
    if (!handler) {
      console.warn('[boot] 未处理的 data-action：', action);
      return;
    }
    handler();
  }

  /** 绑定所有事件（含委托）。 */
  function bindEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (target) {
        handleAction(target.getAttribute('data-action'));
        return;
      }
      // 点设置面板以外的位置时自动收起设置
      const settings = document.querySelector('details.settings');
      if (settings && settings.open && !settings.contains(event.target)) settings.open = false;
    });

    const select = $('scenarioSelect');
    if (select) {
      select.addEventListener('change', (event) => switchScenario(event.target.value));
    }

    const input = $('input');
    if (input) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          send();
        }
      });
    }
  }

  /* ---------------- 启动 ---------------- */

  /** 启动自检：场景库结构有问题时在控制台说清楚，而不是让界面莫名空白。 */
  function selfCheck() {
    const report = core.validateScenarios(scenarios());
    if (report.problems.length) {
      console.error('[boot] 场景库自检未通过：\n' + report.problems.join('\n'));
    } else {
      console.log(`[boot] 场景库自检通过：${report.total} 个场景，${report.categories.length} 个分类`);
    }
    return report;
  }

  /** 应用入口。 */
  function init() {
    const report = selfCheck();
    if (!report.total) {
      const title = $('scenarioTitle');
      if (title) title.textContent = '场景库加载失败，请检查 js/scenarios.js';
      return;
    }
    ui.buildScenarioSelect(scenarios());
    ui.fillSettings(loadSettings());
    bindEvents();
    reset();
  }

  VP.boot = { init, send, score, reset, switchScenario, saveSettings, restoreSettings, callChat };

  init();
})(window.VP);
