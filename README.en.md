# Nursing Communication Simulator · Conversational Virtual Patient

[![tests](https://github.com/l3187773278-star/nursing-communication-training/actions/workflows/test.yml/badge.svg)](https://github.com/l3187773278-star/nursing-communication-training/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#project-layout)

[简体中文](README.md) | **English**

> A **nurse–patient communication training tool** for nursing and medical students.
> The AI plays the patient (or a relative), the student talks as the nurse, and when the
> session ends the AI grades it on four dimensions, quoting the exact lines from the dialogue
> as evidence. 12 scenarios across health education, psychological support, emotion & conflict,
> and complex cases. Zero dependencies, zero build step.

**This is not a diagnostic tool.** It is for communication-skills practice only — it gives no
real medical diagnosis and no treatment advice.

![Screenshot](docs/screenshot.png)

---

## The problem it solves

Communication training is usually role-play between classmates or with a teacher, and the
problems are practical:

- **Not enough practice partners** — one teacher for dozens of students means a few rounds per semester at best.
- **No room to repeat** — for scenes like an agitated relative or end-of-life grief counselling,
  students are embarrassed to act it out, and even more embarrassed to run it again.
- **Feedback is impressionistic** — "your empathy was a bit weak" tells the student the verdict
  but not which sentence to change.

This tool splits "practice partner" and "feedback" and hands both to the AI:

| Stage | How it works |
|---|---|
| Practice partner | Each scenario has its own patient persona (condition, hidden information, emotional state, speech habits). The patient hesitates, sighs, answers sideways, and gets impatient if pushed. |
| Consistency | The patient profile (name / age / condition / allergies) is injected into the system prompt, so the patient does not contradict itself or invent facts after many turns. |
| Feedback | Scored at the end against the scenario's own rubric: 4 dimensions × 0–5 → a 0–100 total. Every dimension must cite **a verbatim quote from the dialogue** as evidence. |
| Reference | A scenario panel gives the student a checklist and sample phrases, while explicitly saying "don't read these out during the conversation". |

## Features

- **12 scenarios**, grouped into four categories: health education (diabetes / hypertension /
  post-coronary-care), psychological support (post-breast-cancer / family grief / postpartum anxiety),
  emotion & conflict (agitated relative / handling a complaint / refusing treatment), and complex
  cases (emotional breakdown during education / relative barging in with questions / multiple
  problems at once).
- **Scenario panel**: a patient information card (what the nurse already knows before the
  conversation, so they don't ask what they should already know) plus a nurse's reference
  (task, checklist, sample phrasing).
- **Conversational practice**: press Enter to send; the patient answers in character, for as many turns as you like.
- **Automatic scoring**: four-dimension rubric → 0–100 total (computed from the dimension scores,
  never invented), plus "missed points / what went well / suggestions".
- **Bring your own model**: anything with an OpenAI-compatible API works
  (DeepSeek / Qwen / Kimi / a local Ollama).

## Running it

### Option 1: local server (recommended)

```bash
node server.js          # or double-click 启动.bat on Windows
# then open http://localhost:3000
```

Click **⚙ Settings** in the top-right and paste an API key:

1. Sign up at [platform.deepseek.com](https://platform.deepseek.com) (a few dollars of credit is plenty);
2. Create an API key, paste it into the settings panel, click Save.

**Why run the local server**: it serves the static files *and* proxies the model API. Calling the
model provider straight from the browser runs into CORS; the local proxy sidesteps that, and it
also keeps your API key out of the browser's request headers.

### Option 2: static hosting (GitHub Pages / Netlify)

`index.html` + `js/` + `styles.css` are the whole app — publish the folder as a static site.
There is no `/api/chat` proxy in that setup, so the front end automatically switches to calling
the provider's OpenAI-compatible endpoint **directly**.

> Note for hosted deployments: the API key lives only in the user's own browser (localStorage) and
> is never uploaded anywhere. Each user brings their own key — the site itself has no key built in,
> and should not.

## Project layout

```
.
├─ index.html          page skeleton (no inline scripts, no inline styles)
├─ styles.css          styles
├─ server.js           zero-dependency local server: static hosting + API proxy
├─ js/
│  ├─ scenarios.js     data for the 12 scenarios (persona / profile / opening line / rubric)
│  ├─ core.js          pure logic: prompt assembly, model-output parsing, score maths, scenario self-check
│  ├─ ui.js            rendering: chat bubbles, scenario tables, score panel (createElement only)
│  └─ boot.js          wiring: state, event delegation, network calls, startup self-check
└─ test/
   ├─ core.test.js     core-logic tests (24 cases, pure assertions, no DOM)
   └─ boot.test.js     startup smoke test + wiring regression (25 cases, runs the real boot in a fake DOM)
```

### Three deliberate design decisions

1. **Pure logic gets its own layer (`js/core.js`).** When the scoring pipeline breaks, it does not
   throw — it fails silently: unparseable JSON is shown raw, one missing dimension score ruins the
   total, an unexpected field name turns everything into "—". These functions touch neither the DOM
   nor the network, so every case can be asserted one by one in Node.
2. **Event delegation instead of inline `onclick`.** The original version called global functions
   from `onclick="send()"`; moving logic into modules silently breaks every one of those. Now it is
   a `data-action` attribute plus a single document-level listener — to see what a button does,
   read the branches of `handleAction`.
3. **Rendering uses `createElement` + `textContent` only.** Both the dialogue and the scoring notes
   come from model output, and string-concatenating that into `innerHTML` is an injection risk.

## Tests

```bash
node --test              # all 49 cases (zero dependencies, Node's built-in node:test)
node test/core.test.js   # core logic only (24 cases)
node test/boot.test.js   # startup smoke test + wiring (25 cases)
```

> Use **`node --test` with no arguments** — it discovers the cases under `test/` itself.
> Writing `node --test test/` works on Node 20, but **from Node 22 on, `test/` is treated as the
> module to execute** and it exits with `Cannot find module`. CI caught this on Node 22 / 24 first.

CI: `.github/workflows/test.yml` runs the syntax check and every case above on Node 20, 22 and 24
for each push and pull request — break something and the commit goes red immediately, instead of
waiting for someone to remember to run the tests.

**Core logic (`test/core.test.js`, 24 cases)** covers: transcript assembly, scoring preconditions,
prompt ordering (persona → profile → general rules), JSON parsing tolerance (bare object / fenced
code block / surrounded by prose / completely unparseable), dimension-score normalisation
(0 is a valid score; out-of-range and non-numeric count as missing), total computation
(mean × 20, rounded; no total when a dimension is missing), result normalisation (Chinese and
English field names, strings promoted to lists, total derived from the dimensions rather than
trusting the model's own number), and a structural self-check over all 12 scenarios.

**Startup smoke + wiring (`test/boot.test.js`, 25 cases)** runs the real startup flow in a minimal
fake DOM, with no browser involved:

- all four scripts execute without throwing (white-screen bugs are caught right here, naming the file);
- the scenario dropdown is grouped by category, and the opening line, patient information card and
  nurse reference genuinely render;
- sending carries the system prompt (with the patient profile and the hard rules), empty messages
  send no request, API errors are shown in the conversation instead of failing silently, and a
  missing key produces an explicit prompt;
- scoring renders the total and all four dimensions, fenced JSON parses, an invalid first response
  triggers exactly one retry, two unparseable responses fall back to showing the raw output, and
  HTML inside model output is treated as text;
- switching scenarios resets the conversation, and an out-of-range index falls back to the first
  scenario instead of blanking the page;
- unavailable local storage produces a notice rather than a frozen UI;
- wiring regression: no inline `onclick` anywhere, every `data-action` has a dispatch branch, every
  `#id` referenced by code exists in `index.html`, script order matches the dependency order, and
  `innerHTML` is only ever used to clear.

> Two traps we hit while building this harness, recorded so nobody repeats them: the fake DOM's
> `innerHTML = ''` must actually clear the child nodes, otherwise "the conversation wasn't cleared
> after switching scenario" is a false alarm; and a custom `fetch` implementation must be recorded
> too, or assertions like "1 chat call + 2 scoring calls" always read zero.

## Adding a scenario

Append one object to the `SCENARIOS` array in `js/scenarios.js` (the dropdown groups itself
automatically):

```js
{
  id: 'unique-english-id',
  category: '健康宣教',        // decides which group it appears under
  title: 'Scenario name',
  label: '患者 · 某某',        // display name on the chat bubbles
  patientInfo: [               // patient card (shown to the nurse AND fed to the AI for consistency)
    ['姓名', '某某'],
    ['性别/年龄', '女 / 60 岁'],
    ['病情', '……'],
  ],
  nurseRef: {                  // nurse-only reference material
    task: 'one-line task for this conversation',
    focus: ['key point 1', 'key point 2'],
    tips: ['sample phrasing'],
  },
  hint: 'a hint shown to the nurse',
  opening: 'the patient’s first line',
  system: 'persona (character + hidden information + hard rules)',
  scoring: 'rubric (4 dimensions + JSON output format)',
}
```

Then run the self-check to confirm the structure is complete:

```bash
node -e "const c=require('./js/core.js'),s=require('./js/scenarios.js');console.log(c.validateScenarios(s))"
```

## Using another model

Open **⚙ Settings** and change two fields (anything OpenAI-compatible works):

| Model | Base URL | Model name |
| --- | --- | --- |
| DeepSeek (default) | `https://api.deepseek.com` | `deepseek-chat` |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Local Ollama | `http://localhost:11434/v1` | whatever you have pulled |

> For a local Ollama, allow cross-origin requests inside Ollama (`OLLAMA_ORIGINS=*`) and put any
> non-empty string in the API key field.

## Known issues & roadmap

- **One scenario's rubric uses a sentence as a dimension key.** The rubric JSON uses a whole
  sentence (e.g. `"总分 = 四个维度换算为百分制后汇总"`) where a dimension name belongs. It runs
  fine — the model returns that key and the UI displays it — but it reads badly and makes the
  nesting easy to misread when editing by hand. The fix is to restructure the rubric as
  `{ dimensions: [{ key: '共情', anchors: [...], weight: 1 }], total: 'mean × 20' }` and have
  `core.buildScoringSystem()` assemble the prompt from that. Re-validating all 12 scenarios is
  part of the change, so it is done separately.
- **No real-key dialogue run yet.** Two layers have been verified: syntax and HTTP
  (`node --check`, routes 200/404, 400 when the key is missing), and browser-level interaction in
  real headless Chromium (first screen renders the scenario, patient card and opening line;
  clicking Send shows the "no API key" notice inside the conversation instead of failing silently;
  clicking Save settings updates the status line and really writes to localStorage; switching
  scenarios resets the conversation; no console errors throughout). Whether "the patient feels
  real and the scores feel fair" needs one run with a real API key, and there is no record of that yet.
- **Single-machine training by design.** No teacher console, no grade management, no multiplayer,
  no voice, no inter-rater reliability study. If someone needs a standalone installer or an
  on-premises / no-data-leaves-the-hospital deployment, packaging and a local-model route are
  separate follow-ups.

## License

MIT
