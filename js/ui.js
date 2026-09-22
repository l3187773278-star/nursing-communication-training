'use strict';

/* ============================================================
   界面渲染层（ui.js）

   只做「把数据画成 DOM」，不做网络请求、不改状态。
   全部用 createElement + textContent 构造节点，不用 innerHTML 拼字符串——
   对话内容和评分说明都来自模型输出，拼字符串就有注入风险。

   依赖：js/core.js（VPCore，用于分组与归一化）
   ============================================================ */

window.VP = window.VP || {};

(function (VP) {
  const core = window.VPCore;

  /**
   * 按 id 取元素。
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  const $ = (id) => document.getElementById(id);

  /**
   * 造一个带类名和文本的元素。
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * 清空元素。
   * @param {HTMLElement} node
   */
  function clear(node) {
    if (node) node.innerHTML = '';
  }

  /* ---------------- 场景下拉框 ---------------- */

  /**
   * 按分类把场景填充进下拉框。
   * @param {Array} scenarios
   */
  function buildScenarioSelect(scenarios) {
    const select = $('scenarioSelect');
    if (!select) return;
    clear(select);

    core.groupByCategory(scenarios).forEach(({ category, indexes }) => {
      const group = document.createElement('optgroup');
      group.label = category;
      indexes.forEach((index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = scenarios[index].title;
        group.appendChild(option);
      });
      select.appendChild(group);
    });
  }

  /* ---------------- 场景资料栏 ---------------- */

  /**
   * 渲染患者基础信息表。
   * @param {Array<[string, string]>} rows
   */
  function renderPatientInfo(rows) {
    const tbody = $('patientInfoTable');
    if (!tbody) return;
    clear(tbody);
    if (!Array.isArray(rows) || rows.length === 0) return;

    rows.forEach((pair) => {
      const tr = document.createElement('tr');
      tr.appendChild(el('td', 'k', pair[0]));
      tr.appendChild(el('td', '', pair[1]));
      tbody.appendChild(tr);
    });
  }

  /**
   * 渲染护士训练参考（任务 + 要点清单 + 参考话术）。
   * @param {{task?: string, focus?: string[], tips?: string[]}} [ref]
   */
  function renderNurseRef(ref) {
    const box = $('nurseRefBody');
    if (!box) return;
    clear(box);
    if (!ref) return;

    if (ref.task) box.appendChild(el('div', 'refTask', `🎯 ${ref.task}`));

    const addBlock = (title, items) => {
      if (!Array.isArray(items) || items.length === 0) return;
      box.appendChild(el('div', 'refLabel', title));
      const list = document.createElement('ul');
      items.forEach((item) => list.appendChild(el('li', '', item)));
      box.appendChild(list);
    };
    addBlock('要点清单（训练时可对照，沟通时别照着念）', ref.focus);
    addBlock('参考话术与应对', ref.tips);
  }

  /**
   * 渲染场景资料（标题 + 患者信息 + 护士参考）。
   * @param {Object} scenario
   */
  function renderBrief(scenario) {
    const tag = $('briefTag');
    if (tag) tag.textContent = scenario.title;
    renderPatientInfo(scenario.patientInfo);
    renderNurseRef(scenario.nurseRef);
  }

  /* ---------------- 对话区 ---------------- */

  /**
   * 追加一条对话气泡。
   * @param {'user'|'patient'} role
   * @param {string} text
   * @param {string} patientLabel 患者侧的显示名（每个场景不同）
   */
  function addBubble(role, text, patientLabel) {
    const chat = $('chat');
    if (!chat) return;

    const wrap = el('div', `msg ${role === 'user' ? 'user' : 'patient'}`);
    wrap.appendChild(el('div', 'label', role === 'user' ? '你（护士）' : patientLabel));
    wrap.appendChild(el('div', 'bubble', text));
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  /** 清空对话区。 */
  function clearChat() {
    clear($('chat'));
  }

  /* ---------------- 状态条与忙碌态 ---------------- */

  /**
   * 短暂显示一条状态，随后恢复成「已就绪」（忙碌时不覆盖忙碌文案）。
   * @param {string} text
   */
  function flashStatus(text) {
    const status = $('status');
    if (!status) return;
    status.textContent = text;
    setTimeout(() => {
      if (!VP.state.busy) status.textContent = '已就绪';
    }, 1200);
  }

  /**
   * 切换忙碌态：禁用按钮、更新状态文案。
   * @param {boolean} on
   * @param {string} [text]
   */
  function setBusy(on, text) {
    VP.state.busy = on;
    const sendBtn = $('sendBtn');
    const scoreBtn = $('scoreBtn');
    if (sendBtn) sendBtn.disabled = on;
    if (scoreBtn) scoreBtn.disabled = on;
    const status = $('status');
    if (status) {
      status.textContent = on ? text || '处理中…' : '已就绪';
      status.classList.toggle('busy', on);
    }
  }

  /* ---------------- 评分结果 ---------------- */

  /**
   * 渲染评分结果。解析失败时原样展示模型输出，方便人工判断。
   * @param {Object|null} parsed 原始 JSON（null 表示解析失败）
   * @param {string} raw 模型原始输出
   */
  function renderScore(parsed, raw) {
    const panel = $('scorePanel');
    const body = $('scoreBody');
    if (!panel || !body) return;
    panel.style.display = 'block';
    clear(body);

    const result = core.normalizeScoreResult(parsed);
    if (!result.ok) {
      body.appendChild(el('pre', '', raw));
      return;
    }

    body.appendChild(
      el('div', 'total', `总分：${result.total === null ? '—' : result.total} / 100`),
    );

    result.dimensions.forEach((dimension) => {
      const row = el('div', 'dim');
      const head = el('div', 'dimHead');
      head.appendChild(el('span', '', dimension.name));
      head.appendChild(
        el('span', 'dimScore', `${dimension.score === null ? '—' : dimension.score} / 5`),
      );
      row.appendChild(head);
      if (dimension.note) row.appendChild(el('div', 'dimDesc', dimension.note));
      if (dimension.evidence) row.appendChild(el('div', 'dimEvid', `依据：${dimension.evidence}`));
      body.appendChild(row);
    });

    addList(body, '遗漏的要点', result.missed);
    addList(body, '做得好的地方', result.strengths);
    addList(body, '改进建议', result.suggestions);
  }

  /**
   * 追加一个带小标题的列表。
   * @param {HTMLElement} parent
   * @param {string} title
   * @param {string[]} items
   */
  function addList(parent, title, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    parent.appendChild(el('div', 'listTitle', title));
    const list = document.createElement('ul');
    items.forEach((item) => list.appendChild(el('li', '', item)));
    parent.appendChild(list);
  }

  /** 隐藏评分面板（切换场景 / 重新开始时用）。 */
  function hideScorePanel() {
    const panel = $('scorePanel');
    if (panel) panel.style.display = 'none';
    clear($('scoreBody'));
  }

  /* ---------------- 设置表单 ---------------- */

  /**
   * 把设置写进表单。
   * @param {{apiKey?: string, baseURL?: string, model?: string}} settings
   */
  function fillSettings(settings) {
    const key = $('apiKey');
    const base = $('baseURL');
    const model = $('model');
    if (key) key.value = settings.apiKey || '';
    if (base) base.value = settings.baseURL || core.DEFAULT_BASE;
    if (model) model.value = settings.model || core.DEFAULT_MODEL;
  }

  /**
   * 从表单读出设置。
   * @returns {{apiKey: string, baseURL: string, model: string}}
   */
  function readSettings() {
    const value = (id) => {
      const node = $(id);
      return node ? node.value.trim() : '';
    };
    return {
      apiKey: value('apiKey'),
      baseURL: value('baseURL') || core.DEFAULT_BASE,
      model: value('model') || core.DEFAULT_MODEL,
    };
  }

  VP.ui = {
    $,
    el,
    clear,
    buildScenarioSelect,
    renderPatientInfo,
    renderNurseRef,
    renderBrief,
    addBubble,
    clearChat,
    flashStatus,
    setBusy,
    renderScore,
    hideScorePanel,
    fillSettings,
    readSettings,
  };
})(window.VP);
