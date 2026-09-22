'use strict';

/* ============================================================
   核心逻辑层（core.js）—— 纯函数，不碰 DOM、不碰网络

   这一层放的是「拿什么去问 AI」和「AI 答完怎么解释」的全部规则：
   - 把对话历史拼成给评分模型的文本
   - 拼 system 提示词（角色规则 / 患者档案 / 评分要求）
   - 解析模型返回的 JSON（含代码块包裹、前后废话的容错）
   - 把各维度得分换算成百分制总分

   为什么单独抽出来：这几件事最容易出错，而且出错时**不报错**——
   评分字段名一变就静默变成「—」、总分和维度分对不上却照样显示。
   它们是纯函数，所以能在 Node 里逐条断言（见 test/core.test.js）。

   双环境共用同一份实现：
     浏览器：<script src="js/core.js"> → window.VPCore
     Node   ：require('./js/core.js')  → module.exports
   ============================================================ */

(function (root) {
  const core = {};

  /* ---------------- 提示词常量 ---------------- */

  /** 追加给患者角色的通用说话方式与铁规则（优先于场景里的旧规则）。 */
  core.PATIENT_RULES = `

【通用说话方式（追加，优先于场景里的旧规则）】
- 像真人一样说话，别像机器人照规则念：句子有长有短，会用"哎呀""那个""就是""哎"这类口头语，会犹豫、停顿、重复。
- 不一定要直接回答对方的问题：可以答非所问、先沉默或叹气、或反问回去，像真人那样有情绪起伏。
- 情绪要跟着对话内容走（被说到痛处会难受、被理解会放松），别每条回复一个套路。
- 可用"（叹气）（沉默了一下）（眼圈红了）"这类极简动作补情绪，但不要每句都用。

【角色铁规则（追加）】
6. 若对方直接问"你是AI吗 / 这是不是模拟 / 你是机器人吗"，你以患者身份自然回应（如"你说啥呢，我是来看病的""什么机器人，我头都大了"），绝不承认是AI或模拟，也不解释"这是在训练"。
7. 不输出旁白，不替对方（护士）说话，只以你扮演的角色开口。`;

  /** 评分模型的统一要求：打分锚点、步骤、输出格式。 */
  core.SCORING_WRAPPER = `你是资深临床护理教学督导，正在对一段护患沟通对话做客观评分。请严格遵守以下规则。

【打分锚点（每个维度 0-5 分，必须严格对照）】
0分 = 完全未涉及该维度，或做法严重错误
1分 = 稍有涉及，但明显错误或敷衍
2分 = 涉及了一部分，但不完整、不到位
3分 = 基本做到，但有明显不足
4分 = 做得较好，仅有小瑕疵
5分 = 完整、准确、有示范性

【评分步骤（按顺序执行）】
1. 先逐条核对场景说明中的"评分要点"，判断每一条是否被做到。
2. 逐维度从对话中找出"护士的具体行为"作为依据。
3. 严格对照上面的锚点给分：禁止一律打高分、禁止全部趋中，该低就低。
4. 总分 = 四个维度得分之和 ÷ 4 × 20，四舍五入取整，必须由维度分换算而来，禁止凭空给分。

【输出要求】
只输出一个 JSON 对象，不要任何多余文字或 markdown 代码块。每个维度对象必须包含"得分"、"说明"、"依据"三个字段；"依据"是从对话里摘录的护士原话（短句）。JSON 的字段结构以下面场景说明为准。

`;

  /** 默认接口地址与模型（界面上可改）。 */
  core.DEFAULT_BASE = 'https://api.deepseek.com';
  core.DEFAULT_MODEL = 'deepseek-chat';

  /* ---------------- 对话历史 → 文本 ---------------- */

  /**
   * 把聊天历史拼成评分用的对话记录。
   * @param {Array<{role: string, content: string}>} history
   * @returns {string} 每行「护士：…」「对方：…」
   */
  core.buildTranscript = (history) =>
    (history || [])
      .map((message) => `${message.role === 'user' ? '护士' : '对方'}：${message.content}`)
      .join('\n');

  /**
   * 是否可以评分：至少要有一问一答。
   * @param {Array} history
   * @returns {boolean}
   */
  core.canScore = (history) => Array.isArray(history) && history.length >= 2;

  /* ---------------- 提示词组装 ---------------- */

  /**
   * 把患者档案拼成 system 追加段，防止患者被问到基本信息时前后矛盾。
   * @param {Array<[string, string]>} [rows] 形如 [['姓名','张三'], ...]
   * @returns {string} 无档案时返回空串
   */
  core.buildPatientProfilePrompt = (rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const lines = rows.map((pair) => `- ${pair[0]}：${pair[1]}`).join('\n');
    return (
      '\n\n【你的基础信息（档案原文）】被问到姓名、年龄、职业、病情、家庭等基本情况时，' +
      '必须按下面逐条如实回答，不得前后矛盾、不得编造。\n' +
      lines
    );
  };

  /**
   * 组装患者角色的 system 提示词。
   * @param {Object} scenario
   * @returns {string}
   */
  core.buildPatientSystem = (scenario) =>
    `${(scenario && scenario.system) || ''}${core.buildPatientProfilePrompt(
      scenario && scenario.patientInfo,
    )}${core.PATIENT_RULES}`;

  /**
   * 组装评分模型的 system 提示词：通用规则 + 本场景的评分量表。
   * @param {Object} scenario
   * @returns {string}
   */
  core.buildScoringSystem = (scenario) =>
    `${core.SCORING_WRAPPER}${(scenario && scenario.scoring) || ''}`;

  /**
   * 评分请求的 user 内容。第二次重试时追加一句「上次不是合法 JSON」的提醒。
   * @param {string} transcript
   * @param {boolean} [isRetry]
   * @returns {string}
   */
  core.buildScoringUser = (transcript, isRetry) =>
    `对话记录如下：\n${transcript}` +
    (isRetry ? '\n\n（你上次没有输出合法的 JSON，请务必只输出一个 JSON 对象，不要有任何多余文字）' : '');

  /**
   * 出题/对话请求的消息数组（system + 历史）。
   * @param {Object} scenario
   * @param {Array<{role: string, content: string}>} history
   * @returns {Array}
   */
  core.buildChatMessages = (scenario, history) => [
    { role: 'system', content: core.buildPatientSystem(scenario) },
    ...(history || []),
  ];

  /* ---------------- 模型输出解析 ---------------- */

  /**
   * 从模型输出里抠出 JSON 对象。
   * 容错三件事：markdown 代码块包裹、前后有多余解释、根本没有 JSON。
   * @param {string} text
   * @returns {Object|null} 解析失败返回 null，由调用方决定是否重试
   */
  core.parseJson = (text) => {
    let trimmed = String(text == null ? '' : text).trim();
    trimmed = trimmed.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  };

  /* ---------------- 评分结果归一化 ---------------- */

  /**
   * 把 0~5 的维度分归一化：非数字、越界、空值一律视为「无有效分」。
   * @param {*} value
   * @returns {number|null}
   */
  core.normalizeScore = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    if (Number.isNaN(num) || num < 0 || num > 5) return null;
    return num;
  };

  /**
   * 取维度对象里的一个字段，兼容中英文字段名。
   * @param {Object} dimension
   * @param {string[]} keys 依次尝试的字段名
   * @param {*} [fallback]
   * @returns {*}
   */
  core.pickField = (dimension, keys, fallback) => {
    if (!dimension || typeof dimension !== 'object') return fallback;
    for (let i = 0; i < keys.length; i++) {
      const value = dimension[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return fallback;
  };

  /**
   * 总分 = 各维度平均分 × 20（四舍五入）。
   * 只有**全部**维度都有有效分时才计算，避免缺一维就给出虚高的总分。
   * @param {Array<number|null>} scores
   * @returns {number|null}
   */
  core.computeTotal = (scores) => {
    if (!Array.isArray(scores) || scores.length === 0) return null;
    if (scores.some((score) => score === null || score === undefined)) return null;
    const sum = scores.reduce((acc, score) => acc + score, 0);
    return Math.round((sum / scores.length) * 20);
  };

  /**
   * 把模型返回的评分结果整理成界面直接可用的结构。
   * @param {Object|null} parsed 模型输出解析结果（null 表示解析失败）
   * @returns {{ok: boolean, total: (number|null), dimensions: Array<{name: string, score: number|null, note: string, evidence: string}>, missed: string[], strengths: string[], suggestions: string[]}}
   */
  core.normalizeScoreResult = (parsed) => {
    const empty = { ok: false, total: null, dimensions: [], missed: [], strengths: [], suggestions: [] };
    if (!parsed || typeof parsed !== 'object') return empty;

    const group = parsed['各维度'] || parsed.dimensions || {};
    const dimensions = Object.entries(group).map(([name, value]) => {
      const isObject = value && typeof value === 'object';
      return {
        name,
        score: core.normalizeScore(isObject ? core.pickField(value, ['得分', 'score'], null) : value),
        note: String((isObject && core.pickField(value, ['说明', 'note'], '')) || ''),
        evidence: String((isObject && core.pickField(value, ['依据', 'evidence'], '')) || ''),
      };
    });

    const scores = dimensions.map((dimension) => dimension.score);
    const computed = core.computeTotal(scores);
    const declared = parsed['总分'] !== undefined ? parsed['总分'] : parsed.total;

    return {
      ok: true,
      // 优先用维度分换算出来的总分；缺维度分时才退回模型自己写的总分
      total: computed !== null ? computed : Number.isFinite(Number(declared)) ? Number(declared) : null,
      dimensions,
      missed: core.toTextList(parsed['遗漏的关键信息'] || parsed['遗漏的宣教要点'] || parsed.missed),
      strengths: core.toTextList(parsed['做得好的地方'] || parsed.strengths),
      suggestions: core.toTextList(parsed['改进建议'] || parsed.suggestions),
    };
  };

  /**
   * 把任意值整理成字符串数组（模型有时给字符串、有时给数组）。
   * @param {*} value
   * @returns {string[]}
   */
  core.toTextList = (value) => {
    if (Array.isArray(value)) return value.filter((item) => item != null).map((item) => String(item));
    if (value === undefined || value === null || value === '') return [];
    return [String(value)];
  };

  /* ---------------- 场景库工具 ---------------- */

  /**
   * 按分类给场景分组，供下拉框渲染。
   * @param {Array} scenarios
   * @returns {Array<{category: string, indexes: number[]}>} 保持原顺序
   */
  core.groupByCategory = (scenarios) => {
    const order = [];
    const groups = new Map();
    (scenarios || []).forEach((scenario, index) => {
      const category = (scenario && scenario.category) || '未分类';
      if (!groups.has(category)) {
        groups.set(category, []);
        order.push(category);
      }
      groups.get(category).push(index);
    });
    return order.map((category) => ({ category, indexes: groups.get(category) }));
  };

  /**
   * 取场景（越界时退回第一个，避免下拉框与数据不同步时白屏）。
   * @param {Array} scenarios
   * @param {number|string} index
   * @returns {Object|null}
   */
  core.getScenario = (scenarios, index) => {
    const list = scenarios || [];
    if (!list.length) return null;
    const i = parseInt(index, 10);
    return list[Number.isFinite(i) && i >= 0 && i < list.length ? i : 0];
  };

  /**
   * 校验场景库是否完整（供启动自检与测试使用）。
   * @param {Array} scenarios
   * @returns {{total: number, categories: string[], problems: string[]}}
   */
  core.validateScenarios = (scenarios) => {
    const list = scenarios || [];
    const problems = [];
    const missingFields = ['id', 'category', 'title', 'label', 'opening', 'system', 'scoring'];

    list.forEach((scenario, index) => {
      const name = (scenario && scenario.title) || `第 ${index + 1} 个场景`;
      missingFields.forEach((field) => {
        if (!scenario || !scenario[field]) problems.push(`${name} 缺少字段 ${field}`);
      });
      if (scenario && scenario.scoring && !/JSON/.test(scenario.scoring)) {
        problems.push(`${name} 的评分量表里没有说明 JSON 输出格式`);
      }
    });

    const ids = list.map((scenario) => scenario && scenario.id);
    ids.forEach((id, index) => {
      if (id && ids.indexOf(id) !== index) problems.push(`场景 id 重复：${id}`);
    });

    return { total: list.length, categories: [...new Set(list.map((s) => s && s.category).filter(Boolean))], problems };
  };

  /* ---------------- 双环境导出 ---------------- */

  if (root) {
    root.VPCore = core;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
})(typeof window !== 'undefined' ? window : null);
