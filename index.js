/*
 * 柏宝绘优化
 * 观察柏宝绘的请求与返回，诊断「没有返回可解析的 JSON 对象」这类失败。
 * 只观察，不改写请求、不修改设置、不动柏宝绘的任何文件。
 * 生成时间：2026-11-13T21:40:48.713Z
 */
(function () {
'use strict';

/* ===== src/monitor.js ===== */
/**
 * 请求监听与诊断
 *
 * 原理：在插件加载时接管 window.fetch，只观察、不改写。
 * - 请求发往 /api/backends/chat-completions/generate 时，记下参数快照。
 * - 响应回来后，复制一段样本做 JSON 可解析性试算。
 * - 判定完立刻把原始响应交回调用方，不改变任何行为。
 *
 * 安全边界：
 * - 不改写请求体、不改写响应体、不拦截、不重试、不抛错。
 * - 不碰柏宝绘的任何文件和数据。
 * - 只在本插件内存里留存最近的诊断记录，刷新即清空。
 */

const ENDPOINT = '/api/backends/chat-completions/generate';
const MAX_RECORDS = 60;

/** @type {Array<Record<string, any>>} */
const records = [];
let installed = false;

function getCtx() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * 去掉 think 块和代码围栏，抓取所有可能的 JSON 候选。
 * 这套逻辑严格照柏宝绘的解析顺序来，保证诊断结果和它的判定一致。
 */
function extractCandidates(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;

  const stripped = text.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();

  // 代码围栏内容
  for (const m of stripped.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    out.push({ source: 'codeblock', text: m[1].trim() });
  }

  // 原文整体
  out.push({ source: 'full', text: stripped });

  // 逐字符找配对的大括号
  for (let i = 0; i < stripped.length; i += 1) {
    if (stripped[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let r = i; r < stripped.length; r += 1) {
      const c = stripped[r];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}' && --depth === 0) {
        out.push({ source: 'brace', text: stripped.slice(i, r + 1) });
        break;
      }
    }
  }

  return out;
}

/**
 * 对一段文本做 JSON 可解析性诊断。
 * 返回 { ok, candidate, reason, detail, hint }
 */
function diagnose(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return {
      ok: false,
      reason: 'empty',
      detail: '响应内容为空',
      hint: '模型没有返回任何内容。检查渠道是否正常，或换一个模型试试。',
    };
  }

  const candidates = extractCandidates(text);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, candidate: c.source, parsed };
      }
    } catch {
      /* 继续试下一个 */
    }
  }

  // 全部失败，判断最可能的原因
  const trimmed = text.trim();
  const hasOpenBrace = trimmed.includes('{');
  const braceCount = (trimmed.match(/\{/g) || []).length;
  const closeCount = (trimmed.match(/\}/g) || []).length;
  const hasThink = /<think(?:ing)?\b/i.test(text);
  const thinkClosed = /<\/think(?:ing)?>/i.test(text);

  if (hasThink && !thinkClosed) {
    return {
      ok: false,
      reason: 'truncated',
      detail: '思考块没有闭合，响应很可能被截断了',
      hint: '把 max_tokens 调小到渠道支持的值，或关闭思考模式。',
    };
  }

  if (braceCount > closeCount) {
    return {
      ok: false,
      reason: 'truncated',
      detail: `大括号不配对（{ 有 ${braceCount} 个，} 只有 ${closeCount} 个），说明输出被截断`,
      hint: '把 max_tokens 调小到渠道支持的值，这最常见。',
    };
  }

  if (!hasOpenBrace) {
    return {
      ok: false,
      reason: 'no-json',
      detail: '响应里完全没有 JSON 对象，模型没有按格式作答',
      hint: '降低 temperature（建议 0.3 到 0.7），或换一个更听话的模型。',
    };
  }

  return {
    ok: false,
    reason: 'malformed',
    detail: '找到了像 JSON 的内容，但解析失败，多半是格式被改写了',
    hint: '降低 temperature；如果渠道改写过内容，换成官方直连试试。',
  };
}

/** 从请求体里提取关注参数。 */
function pickParams(bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object') return {};
  return {
    model: bodyObj.model ?? '',
    temperature: bodyObj.temperature,
    max_tokens: bodyObj.max_tokens,
    stream: bodyObj.stream === true,
    source: bodyObj.chat_completion_source ?? '',
    hasCustomBody: typeof bodyObj.custom_include_body === 'string',
    hasToolChoice: 'tool_choice' in bodyObj,
    hasPresence: 'presence_penalty' in bodyObj,
    hasFrequency: 'frequency_penalty' in bodyObj,
  };
}

/** 从请求的 messages 里判断是不是柏宝绘发的（带它的提示词特征）。 */
function looksLikeBaiBai(bodyObj) {
  const text = JSON.stringify(bodyObj?.messages ?? []);
  return (
    text.includes('bbi_image') ||
    text.includes('[Image Generation Constraint') ||
    text.includes('images') ||
    text.includes('生图')
  );
}

function pushRecord(rec) {
  records.unshift(rec);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  try {
    window.dispatchEvent(new CustomEvent('bbi-optimize:record', { detail: rec }));
  } catch {
    /* 事件派发失败不影响主流程 */
  }
}

/** 读取响应体样本，不消耗调用方的流。 */
async function sampleResponse(resp) {
  try {
    const clone = resp.clone();
    const reader = clone.body?.getReader();
    if (!reader) {
      const text = await clone.text();
      return text.slice(0, 200000);
    }
    const decoder = new TextDecoder();
    let buf = '';
    while (buf.length < 200000) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    try {
      reader.cancel();
    } catch {
      /* 忽略 */
    }
    return buf;
  } catch (err) {
    return `__SAMPLE_FAILED__:${err?.message ?? err}`;
  }
}

/** 从流式 SSE 文本里拼出模型实际输出的内容。 */
function joinSse(text) {
  let content = '';
  let reasoning = '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      const ch = obj?.choices?.[0];
      const d = ch?.delta ?? ch?.message;
      const take = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => x?.text ?? '').join('') : '');
      content += take(d?.content) || take(ch?.text);
      reasoning += take(d?.reasoning) || take(d?.reasoning_content) || take(d?.thinking);
    } catch {
      /* 单行坏了不影响整体 */
    }
  }
  return content.trim() ? content : reasoning;
}

/** 从非流式 JSON 里取出模型输出文本。 */
function joinNonSse(text) {
  try {
    const obj = JSON.parse(text);
    const ch = obj?.choices?.[0];
    const msg = ch?.message;
    const take = (v) => (typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => x?.text ?? '').join('') : '');
    const c = take(msg?.content) || take(ch?.text) || take(obj?.content);
    if (c.trim()) return c;
    return take(msg?.reasoning) || take(msg?.reasoning_content) || take(msg?.thinking);
  } catch {
    return '';
  }
}

/** 分析一次请求/响应。 */
function analyze(bodyObj, requestText, responseText, status, elapsed) {
  const params = pickParams(bodyObj);
  const isBaiBai = looksLikeBaiBai(bodyObj);

  // 流式响应是 SSE 外壳，非流式是普通 JSON
  let modelOutput = '';
  let envelopeError = '';

  if (status >= 400) {
    envelopeError = responseText.slice(0, 500);
  } else if (params.stream) {
    modelOutput = joinSse(responseText);
  } else {
    modelOutput = joinNonSse(responseText);
    if (!modelOutput) {
      try {
        const obj = JSON.parse(responseText);
        if (obj?.error) envelopeError = obj.error?.message ?? JSON.stringify(obj.error).slice(0, 300);
      } catch {
        envelopeError = '响应不是合法 JSON，可能被上游改写';
      }
    }
  }

  const result = envelopeError
    ? {
        ok: false,
        reason: 'http',
        detail: envelopeError,
        hint: '请求本身失败了。先看状态码：401/403 是密钥问题，429 是限流，5xx 是中转故障。',
      }
    : diagnose(modelOutput);

  return {
    time: Date.now(),
    isBaiBai,
    params,
    status,
    elapsed,
    ok: result.ok,
    reason: result.reason,
    detail: result.detail ?? '',
    hint: result.hint ?? '',
    outputLength: modelOutput.length,
    // 存尾部若干字符，够看出是截断还是格式错
    outputTail: modelOutput.slice(-600),
    envelopeError,
  };
}

/** 接管 window.fetch，只观察。 */
function installHook() {
  if (installed) return;
  const orig = window.fetch;
  if (typeof orig !== 'function') return;
  installed = true;

  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url ?? '';

    if (!url.includes(ENDPOINT)) {
      return orig.apply(this, arguments);
    }

    const started = performance.now();
    let bodyObj = null;
    try {
      bodyObj = init?.body ? JSON.parse(init.body) : null;
    } catch {
      bodyObj = null;
    }

    const resp = await orig.apply(this, arguments);
    const elapsed = Math.round(performance.now() - started);

    // 分析放到后台做，绝不拖慢、也不影响柏宝绘拿到响应
    (async () => {
      try {
        const sample = await sampleResponse(resp);
        if (sample.startsWith('__SAMPLE_FAILED__')) {
          pushRecord({
            time: Date.now(),
            isBaiBai: looksLikeBaiBai(bodyObj),
            params: pickParams(bodyObj),
            status: resp.status,
            elapsed,
            ok: null,
            reason: 'sample-failed',
            detail: '响应体采样失败，可能已被其他地方读过',
            hint: '',
            outputLength: 0,
            outputTail: '',
            envelopeError: '',
          });
          return;
        }
        pushRecord(analyze(bodyObj, '', sample, resp.status, elapsed));
      } catch (err) {
        console.debug('[柏宝绘优化] 分析异常', err);
      }
    })();

    return resp;
  };

  console.log('[柏宝绘优化] 请求监听已启动（只观察，不改写）');
}

/** 取出记录（最新的在前）。 */
function getRecords() {
  return records.slice();
}

/** 清空记录。 */
function clearRecords() {
  records.length = 0;
}

/** 统计汇总。 */
function getStats() {
  const total = records.length;
  const failed = records.filter((r) => r.ok === false).length;
  const reasons = {};
  for (const r of records) {
    if (r.ok === false) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  return { total, failed, ok: total - failed, reasons };
}

/* ===== src/channels.js ===== */
/**
 * 渠道参数读取与建议
 *
 * 只读柏宝绘的副 API 渠道设置，算出推荐值。
 * 绝不写入任何配置。这条是硬边界：API 配错会导致账号被限流甚至封禁，
 * 所以本插件只显示建议，改不改由用户自己动手。
 */

const READ_KEY = 'baibai_image';

function getCtx() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * 读出全部副 API 渠道（只读快照）。
 * 返回 { current, channels } —— current 是当前启用的那条。
 */
function readChannels() {
  const ctx = getCtx();
  const raw = ctx?.extensionSettings?.[READ_KEY];
  if (!raw || typeof raw !== 'object') {
    return { available: false, current: null, channels: [], activeId: '' };
  }

  let snap;
  try {
    snap = JSON.parse(JSON.stringify(raw));
  } catch {
    return { available: false, current: null, channels: [], activeId: '' };
  }

  const list = Array.isArray(snap?.channels) ? snap.channels : [];
  const activeId = typeof snap?.activeChannelId === 'string' ? snap.activeChannelId : '';

  const channels = list.map((c) => ({
    id: String(c?.id ?? ''),
    name: String(c?.name ?? '').trim() || '未命名渠道',
    url: String(c?.url ?? ''),
    // 只判断有没有填，绝不把密钥内容带出去
    hasKey: Boolean(String(c?.key ?? '').trim()),
    model: String(c?.model ?? '').trim(),
    temperature: c?.temperature,
    maxTokens: c?.maxTokens,
    timeoutSec: c?.timeoutSec,
    reasoningEffort: String(c?.reasoningEffort ?? '').trim(),
    stream: c?.stream === true,
    excludeParams: String(c?.excludeParams ?? '').trim(),
  }));

  const current = channels.find((c) => c.id === activeId) || channels[0] || null;
  return { available: true, current, channels, activeId };
}

/** 判断模型是不是思考型（会输出 reasoning）。 */
function isReasoningModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return (
    /(^|[/-])(deepseek|qwq|qvq|o1|o3|o4|r1|reason)/.test(m) ||
    m.includes('deepseek') ||
    m.includes('thinking') ||
    m.includes('reason') ||
    m.includes('reasoning') ||
    m.includes('qwq')
  );
}

/**
 * 给某个渠道算推荐值。
 * 返回每一项都是 { key, label, current, suggest, why }，只做展示用。
 */
function buildSuggestions(channel) {
  if (!channel) return [];

  const items = [];
  const reasoning = isReasoningModel(channel.model);

  // 最大 token
  const maxTokens = Number(channel.maxTokens) || 0;
  let suggestTokens = 8192;
  if (maxTokens > 32768) suggestTokens = 8192;
  else if (maxTokens > 16384) suggestTokens = 8192;
  else if (maxTokens === 0) suggestTokens = 4096;
  items.push({
    key: 'maxTokens',
    label: '最大 token',
    current: maxTokens || '未设置',
    suggest: suggestTokens,
    changed: maxTokens !== suggestTokens,
    why:
      maxTokens > 32768
        ? `当前 ${maxTokens}，多数中转服务不支持这么大的值，超出会被拒或静默截断。改成 ${suggestTokens} 更稳。`
        : `当前 ${maxTokens || '未设置'}，建议保持在一个渠道能接受的范围。`,
  });

  // 温度
  const temp = channel.temperature;
  const numTemp = Number(temp);
  const suggestTemp = 0.5;
  const tempChanged = Number.isFinite(numTemp) ? Math.abs(numTemp - suggestTemp) > 0.05 : true;
  items.push({
    key: 'temperature',
    label: '温度',
    current: Number.isFinite(numTemp) ? numTemp : '未设置',
    suggest: suggestTemp,
    changed: tempChanged,
    why: tempChanged
      ? `当前 ${Number.isFinite(numTemp) ? numTemp : '未设置'}。生图提示词要求严格按 JSON 格式输出，温度过高模型容易自由发挥，格式就跑偏了。${suggestTemp} 左右更听话。`
      : `当前 ${numTemp}，这个值对格式类任务合适。`,
  });

  // 思考强度
  const effort = channel.reasoningEffort || 'auto';
  const suggestEffort = reasoning ? 'low' : 'auto';
  const effortChanged = reasoning && effort !== suggestEffort;
  items.push({
    key: 'reasoningEffort',
    label: '思考强度',
    current: effort,
    suggest: suggestEffort,
    changed: effortChanged,
    why: reasoning
      ? `检测到「${channel.model}」是思考型模型。思考会大量占用输出预算，柏宝绘的提示词又要求在 thinking 里逐字段填表，很容易把预算吃光导致 JSON 写不完。建议调到 ${suggestEffort}，甚至关掉思考。`
      : `当前模型不像思考型，保持 auto 即可。`,
  });

  // 超时
  const timeout = Number(channel.timeoutSec) || 0;
  const suggestTimeout = 180;
  items.push({
    key: 'timeoutSec',
    label: '超时（秒）',
    current: timeout || '未设置',
    suggest: suggestTimeout,
    changed: timeout > 0 && timeout < 120,
    why:
      timeout > 0 && timeout < 120
        ? `当前 ${timeout} 秒偏短，思考型模型写满一整份 JSON 可能来不及。`
        : `当前 ${timeout || '未设置'} 秒，够用。`,
  });

  // 流式
  items.push({
    key: 'stream',
    label: '流式传输',
    current: channel.stream ? '开启' : '关闭',
    suggest: '开启',
    changed: !channel.stream,
    why: channel.stream
      ? '已开启。流式能让长输出更稳定，不要关。'
      : '建议开启。关闭流式时，长输出更容易在中转处被整段截断。',
  });

  return items;
}

/** 排除参数建议。 */
function buildExcludeHint(channel) {
  if (!channel) return '';
  const has = channel.excludeParams;
  if (has) return `当前已排除：${has}。如果仍然失败，可以再试加 reasoning_effort。`;
  return '如果调完参数还是失败，可以往这里填 reasoning_effort 试试，用来把思考参数从请求里删掉。';
}

/* ===== src/apply.js ===== */
/**
 * 参数替换
 *
 * 本插件唯一会写入配置的地方。
 * 因为 API 配错可能导致限流甚至封号，这里采取了最保守的做法：
 * 1. 只在用户点过「确认替换」之后才调用；
 * 2. 只改数值型参数，绝不碰 url、key、model、name 这些身份字段；
 * 3. 不改 activeChannelId，绝不替你切换渠道；
 * 4. 写完不自动保存，让用户回柏宝绘自己点「完成」。
 */

const WRITE_KEY = 'baibai_image';

/** 允许被本插件修改的字段白名单。 */
const ALLOWED_KEYS = new Set([
  'temperature',
  'maxTokens',
  'timeoutSec',
  'reasoningEffort',
  'stream',
]);

/** 明确禁止触碰的字段，写在这只是为了让人一眼看到红线。 */
const FORBIDDEN_KEYS = new Set([
  'url',
  'key',
  'model',
  'name',
  'id',
  'endpoints',
  'activeEndpointId',
  'activeChannelId',
  'excludeParams',
]);

function getCtx() {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/** HTML 转义，用于把用户数据放进 innerHTML 时。 */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 把建议应用到指定渠道。
 *
 * @param {string} channelId 目标渠道 id（必须和当前激活的一致才会改）
 * @param {Array<{key:string,suggest:any,label:string}>} items 建议项
 * @returns {{ok:boolean, changed:number, message?:string}}
 */
function applySuggestions(channelId, items) {
  const ctx = getCtx();
  if (!ctx?.extensionSettings) {
    return { ok: false, changed: 0, message: '酒馆上下文不可用，无法写入。' };
  }

  const root = ctx.extensionSettings[WRITE_KEY];
  if (!root || typeof root !== 'object') {
    return { ok: false, changed: 0, message: '没有读到柏宝绘的设置。' };
  }

  // 安全闸：只允许改当前激活的渠道，防止误改别的渠道
  const activeId = typeof root.activeChannelId === 'string' ? root.activeChannelId : '';
  if (activeId && channelId && activeId !== channelId) {
    return {
      ok: false,
      changed: 0,
      message: '目标渠道和当前启用的渠道不一致，已拒绝修改。请先在柏宝绘里切换到该渠道。',
    };
  }

  const list = Array.isArray(root.channels) ? root.channels : [];
  const target = list.find((c) => String(c?.id ?? '') === channelId);
  if (!target) {
    return { ok: false, changed: 0, message: '没有在设置里找到这个渠道，可能已被删除。' };
  }

  let changed = 0;
  for (const item of items) {
    const key = item.key;
    if (!ALLOWED_KEYS.has(key)) continue;
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (item.suggest === undefined || item.suggest === null) continue;

    const before = target[key];
    if (String(before) === String(item.suggest)) continue;

    target[key] = item.suggest;
    changed += 1;
  }

  if (!changed) {
    return { ok: true, changed: 0, message: '没有需要修改的项。' };
  }

  // 关键：不调用 saveSettingsDebounced，不替用户保存。
  // 柏宝绘的界面会自己读这份设置，用户点「完成」时才真正落盘。
  return { ok: true, changed };
}

/* ===== src/floatball.js ===== */
/**
 * 悬浮球
 *
 * 可开关的圆形按钮，点一下打开诊断面板。
 *
 * 位置策略（这次重写的原因）：
 * 早先用 JS 算 left/top 并用 localStorage 记拖动位置，换个屏幕尺寸就会跑到屏幕外。
 * 现在改用纯 CSS 固定定位，默认落在屏幕中间偏下，用 translate 居中，
 * 不依赖任何像素计算，手机、平板、横竖屏切换都不会跑偏。
 * 拖动仍然可以，但坐标会被强制夹在可视范围内，并且在窗口尺寸变化时自动收回。
 */

const FLOAT_ID = 'bbo-ball';
const FLOAT_STYLE_ID = 'bbo-ball-style';
const STORAGE_KEY = 'bbo.ball.visible';
const POS_KEY = 'bbo.ball.pos';
const BALL_SIZE = 46;
const BALL_SIZE_SM = 42;

const FLOAT_CSS = `
#bbo-ball{
  position:fixed;
  z-index:100001;
  width:${BALL_SIZE}px;
  height:${BALL_SIZE}px;
  border-radius:50%;
  display:flex;
  align-items:center;
  justify-content:center;
  cursor:pointer;
  background:var(--SmartThemeBlurTintColor,#1b1c21);
  color:var(--SmartThemeBodyColor,#e6e6e6);
  border:1px solid rgba(255,255,255,.22);
  box-shadow:0 6px 18px rgba(0,0,0,.5);
  user-select:none;
  touch-action:none;
  box-sizing:border-box;
  transition:transform .15s ease,box-shadow .15s ease;
  /* 默认位置：屏幕水平居中、垂直偏下 */
  left:50%;
  bottom:12%;
}
#bbo-ball:hover{transform:scale(1.06);box-shadow:0 8px 22px rgba(0,0,0,.6)}
#bbo-ball:active{transform:scale(.96)}
#bbo-ball svg{width:22px;height:22px;pointer-events:none}
#bbo-ball.has-alert{border-color:rgba(230,120,120,.8)}
#bbo-ball .bbo-ball-dot{
  position:absolute;top:3px;right:3px;width:9px;height:9px;border-radius:50%;
  background:#e67878;border:1px solid rgba(0,0,0,.4);display:none;
}
#bbo-ball.has-alert .bbo-ball-dot{display:block}

/* 手机：球缩小一点，位置抬高一点，避免压到底部输入框 */
@media (max-width: 700px){
  #bbo-ball{
    width:${BALL_SIZE_SM}px;
    height:${BALL_SIZE_SM}px;
    bottom:16%;
  }
  #bbo-ball svg{width:20px;height:20px}
}
`;

function ensureFloatStyle() {
  if (document.getElementById(FLOAT_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = FLOAT_STYLE_ID;
  s.textContent = FLOAT_CSS;
  document.head.appendChild(s);
}

function readPos() {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.left === 'number' && typeof p?.top === 'number') return p;
  } catch {
    /* 忽略 */
  }
  return null;
}

function savePos(left, top) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ left, top }));
  } catch {
    /* 忽略 */
  }
}

function clearPos() {
  try {
    localStorage.removeItem(POS_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 悬浮球当前是否应该显示。默认显示。 */
function isBallEnabled() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

/** 设置悬浮球显示与否。 */
function setBallEnabled(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* 忽略 */
  }
  if (on) mountFloatBall();
  else unmountFloatBall();
}

let removers = [];

/** 当前球的尺寸（手机小一点）。 */
function ballSize() {
  return window.innerWidth <= 700 ? BALL_SIZE_SM : BALL_SIZE;
}

/** 把球夹回可视范围内。 */
function clampIntoView(ball) {
  const rect = ball.getBoundingClientRect();
  const size = ballSize();
  const margin = 4;
  const maxLeft = Math.max(margin, window.innerWidth - size - margin);
  const maxTop = Math.max(margin, window.innerHeight - size - margin);

  let left = rect.left;
  let top = rect.top;
  let changed = false;

  if (left < margin) {
    left = margin;
    changed = true;
  } else if (left > maxLeft) {
    left = maxLeft;
    changed = true;
  }
  if (top < margin) {
    top = margin;
    changed = true;
  } else if (top > maxTop) {
    top = maxTop;
    changed = true;
  }

  if (changed) {
    ball.style.left = `${left}px`;
    ball.style.top = `${top}px`;
    ball.style.bottom = 'auto';
  }
}

/** 挂上悬浮球（已存在则跳过）。 */
function mountFloatBall() {
  if (!isBallEnabled()) return;
  if (document.getElementById(FLOAT_ID)) return;
  ensureFloatStyle();

  const ball = document.createElement('div');
  ball.id = FLOAT_ID;
  ball.title = '柏宝绘优化';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 12h4l3 8 4-16 3 8h4');
  svg.appendChild(path);
  ball.appendChild(svg);

  const dot = document.createElement('div');
  dot.className = 'bbo-ball-dot';
  ball.appendChild(dot);

  // 恢复保存位置时，用 px 定位并立刻夹进可视范围。
  // 默认不动 CSS，让 left:50% + bottom:12% 生效，任何时候都在中间。
  const saved = readPos();
  if (saved) {
    ball.style.left = `${saved.left}px`;
    ball.style.top = `${saved.top}px`;
    ball.style.bottom = 'auto';
  }

  document.body.appendChild(ball);

  if (saved) {
    // 布局完成后修正一次，防止保存的坐标在当前屏幕上超出可视区
    requestAnimationFrame(() => clampIntoView(ball));
  }

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let offsetY = 0;

  function clampVal(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  const onDown = (e) => {
    const pt = e.touches ? e.touches[0] : e;
    const rect = ball.getBoundingClientRect();
    dragging = true;
    moved = false;
    startX = pt.clientX;
    startY = pt.clientY;
    offsetX = pt.clientX - rect.left;
    offsetY = pt.clientY - rect.top;
    // 拖动时改用 px 定位，避免 left:50% 造成跳变
    ball.style.left = `${rect.left}px`;
    ball.style.top = `${rect.top}px`;
    ball.style.bottom = 'auto';
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    if (!moved && Math.hypot(pt.clientX - startX, pt.clientY - startY) > 5) moved = true;
    if (!moved) return;
    const size = ballSize();
    const margin = 4;
    const left = clampVal(pt.clientX - offsetX, margin, window.innerWidth - size - margin);
    const top = clampVal(pt.clientY - offsetY, margin, window.innerHeight - size - margin);
    ball.style.left = `${left}px`;
    ball.style.top = `${top}px`;
    e.preventDefault();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const rect = ball.getBoundingClientRect();
      savePos(Math.round(rect.left), Math.round(rect.top));
    }
  };

  const onClick = (e) => {
    if (moved) {
      moved = false;
      return;
    }
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent('bbo-open-panel'));
  };

  // 屏幕尺寸或方向变化时把球收回可视区
  const onResize = () => {
    if (document.getElementById(FLOAT_ID)) clampIntoView(ball);
  };

  // 双击球 = 回到屏幕中间，位置记录清空
  const onDblClick = (e) => {
    e.stopPropagation();
    clearPos();
    ball.style.left = '50%';
    ball.style.top = 'auto';
    ball.style.bottom = '12%';
  };

  ball.addEventListener('mousedown', onDown);
  ball.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('touchend', onUp);
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  ball.addEventListener('click', onClick);
  ball.addEventListener('dblclick', onDblClick);

  removers = [
    () => window.removeEventListener('mousemove', onMove),
    () => window.removeEventListener('touchmove', onMove),
    () => window.removeEventListener('mouseup', onUp),
    () => window.removeEventListener('touchend', onUp),
    () => window.removeEventListener('resize', onResize),
    () => window.removeEventListener('orientationchange', onResize),
  ];
}

/** 摘掉悬浮球。 */
function unmountFloatBall() {
  const ball = document.getElementById(FLOAT_ID);
  if (ball) ball.remove();
  for (const fn of removers) {
    try {
      fn();
    } catch {
      /* 忽略 */
    }
  }
  removers = [];
}

/** 有新的失败记录时给悬浮球亮红点。 */
function flashBallAlert() {
  const ball = document.getElementById(FLOAT_ID);
  if (!ball) return;
  ball.classList.add('has-alert');
}

/* ===== src/panel.js ===== */
/**
 * 诊断面板 · 界面
 *
 * 两个页签：请求记录、渠道建议。
 * 记录页只读展示；建议页给出推荐值，一键替换必须二次确认。
 */



const STYLE_ID = 'bbo-style';

const REASON_LABEL = {
  truncated: '被截断',
  'no-json': '没按格式答',
  malformed: '格式坏了',
  empty: '空响应',
  http: '请求失败',
  'sample-failed': '无法采样',
};

const CSS = `
/* 遮罩层贴满可视区。位置和尺寸由 JS 用 px 实测后写入，
   CSS 只做兜底，不依赖 vh / dvh / 百分比。
   原因：vh 与 dvh 在酒馆内嵌布局和手机地址栏伸缩时都会算错。 */
.bbo-mask{
  position:fixed;
  top:0;left:0;right:0;bottom:0;
  z-index:100004;
  display:flex;
  align-items:center;
  justify-content:center;
  background:rgba(0,0,0,.55);
  padding:16px;
  box-sizing:border-box;
  overflow:auto;
}
.bbo-panel{
  display:flex;
  flex-direction:column;
  background:var(--SmartThemeBlurTintColor,#17181c);
  color:var(--SmartThemeBodyColor,#e6e6e6);
  border:1px solid rgba(255,255,255,.1);
  border-radius:10px;
  box-shadow:0 20px 56px rgba(0,0,0,.55);
  font-size:13px;
  overflow:hidden;
  flex:0 0 auto;
  /* 具体宽高由 JS 按实测视口写入，这里只给桌面端兜底值 */
  width:860px;
  max-width:100%;
  height:600px;
  max-height:100%;
}
.bbo-head{display:flex;align-items:center;gap:12px;padding:0 14px;height:46px;flex:0 0 46px;border-bottom:1px solid rgba(255,255,255,.08)}
.bbo-title{font-size:14px;font-weight:600}
.bbo-tabs{display:flex;gap:2px;margin-left:8px}
.bbo-tab{font:inherit;font-size:12.5px;padding:5px 12px;border:0;border-radius:6px;background:none;color:inherit;opacity:.6;cursor:pointer}
.bbo-tab:hover{opacity:.9;background:rgba(255,255,255,.06)}
.bbo-tab.on{opacity:1;background:rgba(255,255,255,.12)}
.bbo-sum{margin-left:auto;font-size:12px;opacity:.65;font-variant-numeric:tabular-nums}
.bbo-x{width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:none;border:0;color:inherit;opacity:.55;cursor:pointer;border-radius:6px;font-size:14px}
.bbo-x:hover{opacity:1;background:rgba(255,255,255,.1)}
.bbo-body{flex:1;display:flex;min-height:0}
.bbo-list{width:54%;min-width:240px;overflow-y:auto;border-right:1px solid rgba(255,255,255,.08)}
.bbo-detail{flex:1;overflow-y:auto;padding:12px 14px;min-width:0}

/* ===== 渠道建议页 ===== */
.bbo-ch-head{padding:14px 12px 10px;border-bottom:1px solid rgba(255,255,255,.06)}
.bbo-ch-name{font-size:14px;font-weight:600}
.bbo-ch-model{margin-top:3px;font-size:11.5px;opacity:.55;word-break:break-all}
.bbo-ch-intro{padding:10px 12px;font-size:12px;line-height:1.7;opacity:.65}
.bbo-ch-item{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
.bbo-ch-item:hover{background:rgba(255,255,255,.05)}
.bbo-ch-top{display:flex;align-items:center;gap:8px}
.bbo-ch-label{font-size:12.5px;font-weight:600}
.bbo-ch-badge{margin-left:auto;font-size:10.5px;padding:1px 6px;border-radius:4px;border:1px solid}
.bbo-ch-badge.bad{color:#e89696;border-color:rgba(230,120,120,.5)}
.bbo-ch-badge.ok{color:#8fdcb4;border-color:rgba(108,204,153,.45)}
.bbo-ch-cmp{margin-top:4px;font-size:12px;font-variant-numeric:tabular-nums}
.bbo-ch-cmp .arw,.bbo-ch-big .arw{opacity:.4;margin:0 6px}
.bbo-ch-cmp b,.bbo-ch-big b{color:#8fdcb4}
.bbo-ch-why{margin-top:4px;font-size:11.5px;line-height:1.6;opacity:.55}
.bbo-ch-actions{padding:14px 12px}
.bbo-ch-apply{width:100%;font:inherit;font-size:13px;padding:9px 0;border-radius:6px;border:1px solid rgba(230,120,120,.5);background:rgba(230,120,120,.15);color:inherit;cursor:pointer}
.bbo-ch-apply:hover{background:rgba(230,120,120,.25)}
.bbo-detail-title{font-size:14px;font-weight:600;margin-bottom:14px}
.bbo-ch-big{font-size:16px;font-variant-numeric:tabular-nums;padding:10px 12px;border-radius:6px;background:rgba(0,0,0,.25)}
.bbo-confirm-list{margin:12px 0;padding:10px 12px;border-radius:6px;background:rgba(0,0,0,.25);font-size:12.5px;line-height:1.9}
.bbo-confirm-row{font-variant-numeric:tabular-nums}
.bbo-confirm-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.bbo-confirm-btns button{font:inherit;font-size:12.5px;padding:7px 16px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
.bbo-confirm-btns button.primary{background:rgba(230,120,120,.2);border-color:rgba(230,120,120,.5)}
.bbo-row{padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
.bbo-row:hover{background:rgba(255,255,255,.05)}
.bbo-row.on{background:rgba(120,180,255,.14)}
.bbo-row-top{display:flex;align-items:center;gap:8px;font-size:12.5px}
.bbo-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.bbo-dot.ok{background:#6cc99a}
.bbo-dot.bad{background:#e67878}
.bbo-dot.warn{background:#e0b46c}
.bbo-tag{font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid rgba(255,255,255,.18);opacity:.75}
.bbo-tm{margin-left:auto;font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}
.bbo-row-sub{margin-top:3px;font-size:11.5px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bbo-empty{padding:48px 18px;text-align:center;opacity:.5;line-height:1.9;font-size:12.5px}
.bbo-sec{margin-bottom:16px}
.bbo-sec h4{margin:0 0 6px;font-size:12px;letter-spacing:.08em;opacity:.55;font-weight:600}
.bbo-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;line-height:1.6}
.bbo-kv dt{opacity:.55;white-space:nowrap}
.bbo-kv dd{margin:0;word-break:break-all}
.bbo-hint{padding:10px 12px;border-radius:6px;line-height:1.75;font-size:12.5px}
.bbo-hint.good{background:rgba(108,204,153,.12);border:1px solid rgba(108,204,153,.3)}
.bbo-hint.bad{background:rgba(230,120,120,.12);border:1px solid rgba(230,120,120,.3)}
.bbo-pre{margin:0;padding:10px;border-radius:6px;background:rgba(0,0,0,.3);font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto}
.bbo-foot{padding:10px 14px;flex:0 0 auto;border-top:1px solid rgba(255,255,255,.08);display:flex;gap:10px;align-items:center}
.bbo-foot button{font:inherit;font-size:12.5px;padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
.bbo-foot button:hover{background:rgba(255,255,255,.13)}
.bbo-foot .note{font-size:11.5px;opacity:.5;margin-right:auto;line-height:1.5}

@media (max-width: 700px){
  .bbo-mask{padding:0;align-items:stretch}
  .bbo-panel{
    width:340px;      /* 由 JS 改写为实测宽度 */
    height:560px;     /* 由 JS 改写为实测高度 */
    max-width:none;
    max-height:none;
    border-radius:0;
    border:0;
    margin:0;
  }
  .bbo-head{height:auto;flex:0 0 auto;padding:8px 10px;flex-wrap:wrap;gap:6px}
  .bbo-title{font-size:14px}
  .bbo-tabs{order:3;width:100%;margin-left:0}
  .bbo-tab{flex:1;text-align:center;padding:7px 0}
  .bbo-sum{margin-left:auto;font-size:11.5px}
  .bbo-body{flex-direction:column;min-height:0}
  .bbo-list{width:100%;height:240px;flex:0 0 240px;border-right:0;border-bottom:1px solid rgba(255,255,255,.08)}
  .bbo-detail{flex:1 1 auto;min-height:120px}
  .bbo-x{width:32px;height:32px;font-size:15px}
  .bbo-row{padding:11px 12px}
  .bbo-foot{padding:10px;flex:0 0 auto}
  .bbo-foot button{padding:9px 14px;font-size:13.5px}
  .bbo-pre{max-height:160px}
}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function statusOf(rec) {
  if (rec.ok === true) return { cls: 'ok', text: '正常' };
  if (rec.ok === null) return { cls: 'warn', text: '未判定' };
  return { cls: 'bad', text: REASON_LABEL[rec.reason] || '失败' };
}

function renderDetail(box, rec) {
  box.innerHTML = '';
  if (!rec) {
    const empty = el('div', 'bbo-empty', '点左侧任意一条查看详情');
    box.appendChild(empty);
    return;
  }

  // 结论
  const secResult = el('div', 'bbo-sec');
  secResult.appendChild(el('h4', null, '结论'));
  const hint = el('div', `bbo-hint ${rec.ok ? 'good' : 'bad'}`);
  if (rec.ok === true) {
    hint.textContent = '这次返回能被正常解析，柏宝绘不会报「没有返回可解析的 JSON 对象」。';
  } else if (rec.ok === null) {
    hint.textContent = rec.detail || '无法判定';
  } else {
    hint.textContent = `${rec.detail}${rec.hint ? '\n建议：' + rec.hint : ''}`;
  }
  hint.style.whiteSpace = 'pre-wrap';
  secResult.appendChild(hint);
  box.appendChild(secResult);

  // 请求参数
  const secParam = el('div', 'bbo-sec');
  secParam.appendChild(el('h4', null, '请求参数'));
  const dl = document.createElement('dl');
  dl.className = 'bbo-kv';
  const add = (k, v) => {
    dl.appendChild(document.createElement('dt')).textContent = k;
    dl.appendChild(document.createElement('dd')).textContent = v === undefined || v === '' ? '—' : String(v);
  };
  add('模型', rec.params.model);
  add('温度', rec.params.temperature);
  add('max_tokens', rec.params.max_tokens);
  add('流式', rec.params.stream ? '是' : '否');
  add('来源', rec.params.source);
  add('耗时', `${rec.elapsed} ms`);
  add('状态码', rec.status);
  secParam.appendChild(dl);
  box.appendChild(secParam);

  // 常见嫌疑参数提示
  const warnings = [];
  if (Number(rec.params.max_tokens) >= 32000) {
    warnings.push(`max_tokens 是 ${rec.params.max_tokens}，多数渠道不支持这么大，容易被拒或截断。`);
  }
  if (Number(rec.params.temperature) >= 0.9) {
    warnings.push(`温度是 ${rec.params.temperature}，格式类任务偏高，建议 0.3 到 0.7。`);
  }
  if (rec.params.hasCustomBody) {
    warnings.push('请求里带了 custom_include_body，部分中转会因此报错。');
  }
  if (warnings.length) {
    const secWarn = el('div', 'bbo-sec');
    secWarn.appendChild(el('h4', null, '可疑参数'));
    for (const w of warnings) {
      const p = el('div', 'bbo-hint bad');
      p.style.marginBottom = '6px';
      p.textContent = w;
      secWarn.appendChild(p);
    }
    box.appendChild(secWarn);
  }

  // 输出尾部
  if (rec.outputTail) {
    const secOut = el('div', 'bbo-sec');
    secOut.appendChild(el('h4', null, `模型输出尾部（共 ${rec.outputLength} 字）`));
    secOut.appendChild(el('pre', 'bbo-pre', rec.outputTail));
    box.appendChild(secOut);
  }

  if (rec.envelopeError) {
    const secErr = el('div', 'bbo-sec');
    secErr.appendChild(el('h4', null, '错误信息'));
    secErr.appendChild(el('pre', 'bbo-pre', rec.envelopeError));
    box.appendChild(secErr);
  }
}

/** 打开诊断面板。 */
function openPanel() {
  ensureStyle();

  const mask = el('div', 'bbo-mask');
  const panel = el('div', 'bbo-panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const head = el('div', 'bbo-head');
  head.appendChild(el('div', 'bbo-title', '柏宝绘诊断'));

  // 页签
  const tabs = el('div', 'bbo-tabs');
  const tabLog = el('button', 'bbo-tab on', '请求记录');
  const tabCh = el('button', 'bbo-tab', '渠道建议');
  tabLog.type = 'button';
  tabCh.type = 'button';
  tabs.append(tabLog, tabCh);
  head.appendChild(tabs);

  const sum = el('div', 'bbo-sum');
  head.appendChild(sum);
  const x = el('button', 'bbo-x', '✕');
  x.type = 'button';
  x.setAttribute('aria-label', '关闭');
  head.appendChild(x);
  panel.appendChild(head);

  const body = el('div', 'bbo-body');
  const list = el('div', 'bbo-list');
  const detail = el('div', 'bbo-detail');
  body.append(list, detail);
  panel.appendChild(body);

  const foot = el('div', 'bbo-foot');
  const note = el('div', 'note', '只观察，不修改任何设置');
  const refreshBtn = el('button', null, '刷新');
  const clearBtn = el('button', null, '清空');
  refreshBtn.type = 'button';
  clearBtn.type = 'button';
  foot.append(note, refreshBtn, clearBtn);
  panel.appendChild(foot);

  let currentTime = null;
  let mode = 'log';

  /* ========== 渠道建议页 ========== */
  function paintChannels() {
    list.innerHTML = '';
    detail.innerHTML = '';
    sum.textContent = '';

    const { available, current } = readChannels();

    if (!available || !current) {
      list.appendChild(
        el('div', 'bbo-empty', '没有读到柏宝绘的渠道设置。\n请确认柏宝绘已安装并至少配置了一个渠道。'),
      );
      return;
    }

    const headEl = el('div', 'bbo-ch-head');
    headEl.appendChild(el('div', 'bbo-ch-name', current.name));
    headEl.appendChild(el('div', 'bbo-ch-model', current.model || '未填写模型'));
    list.appendChild(headEl);

    const items = buildSuggestions(current);
    const changedCount = items.filter((i) => i.changed).length;

    const intro = el('div', 'bbo-ch-intro');
    intro.textContent =
      changedCount > 0
        ? `按当前渠道算出 ${changedCount} 项建议调整。下面只列建议，不会自动改动。`
        : '当前参数看起来已经合适，没有需要调整的地方。';
    list.appendChild(intro);

    for (const item of items) {
      const row = el('div', 'bbo-ch-item');
      const top = el('div', 'bbo-ch-top');
      top.appendChild(el('span', 'bbo-ch-label', item.label));
      top.appendChild(
        el('span', `bbo-ch-badge ${item.changed ? 'bad' : 'ok'}`, item.changed ? '可调整' : '合适'),
      );
      row.appendChild(top);

      const cmp = el('div', 'bbo-ch-cmp');
      cmp.innerHTML = `${escapeHtml(String(item.current))} <span class="arw">→</span> <b>${escapeHtml(String(item.suggest))}</b>`;
      row.appendChild(cmp);

      row.appendChild(el('div', 'bbo-ch-why', item.why));
      list.appendChild(row);

      row.addEventListener('click', () => renderChDetail(item, current));
    }

    if (changedCount > 0) {
      const bar = el('div', 'bbo-ch-actions');
      const btn = el('button', 'bbo-ch-apply', '一键替换（需确认）');
      btn.type = 'button';
      btn.addEventListener('click', () => confirmApply(current, items));
      bar.appendChild(btn);
      list.appendChild(bar);
    }

    renderChDetail(items.find((i) => i.changed) || items[0], current);
  }

  function renderChDetail(item, channel) {
    detail.innerHTML = '';
    if (!item) return;

    detail.appendChild(el('div', 'bbo-detail-title', item.label));

    const sec = el('div', 'bbo-sec');
    sec.appendChild(el('h4', null, '当前 → 建议'));
    const big = el('div', 'bbo-ch-big');
    big.innerHTML = `${escapeHtml(String(item.current))} <span class="arw">→</span> <b>${escapeHtml(String(item.suggest))}</b>`;
    sec.appendChild(big);
    detail.appendChild(sec);

    const secWhy = el('div', 'bbo-sec');
    secWhy.appendChild(el('h4', null, '为什么'));
    const h = el('div', `bbo-hint ${item.changed ? 'bad' : 'good'}`);
    h.textContent = item.why;
    secWhy.appendChild(h);
    detail.appendChild(secWhy);

    const secEx = el('div', 'bbo-sec');
    secEx.appendChild(el('h4', null, '排除参数'));
    const ex = el('div', 'bbo-hint');
    ex.textContent = buildExcludeHint(channel);
    secEx.appendChild(ex);
    detail.appendChild(secEx);

    const warn = el('div', 'bbo-sec');
    warn.appendChild(el('h4', null, '注意'));
    const w = el('div', 'bbo-hint bad');
    w.textContent =
      '这里的全部内容只是建议。API 渠道用错可能导致限流甚至封号，本插件默认不替你改任何东西。';
    warn.appendChild(w);
    detail.appendChild(warn);
  }

  /** 二次确认后才会动手。 */
  function confirmApply(channel, items) {
    detail.innerHTML = '';
    detail.appendChild(el('div', 'bbo-detail-title', '确认替换'));

    const changed = items.filter((i) => i.changed);

    const warn = el('div', 'bbo-hint bad');
    warn.style.whiteSpace = 'pre-wrap';
    warn.textContent =
      `即将修改渠道「${channel.name}」的 ${changed.length} 项参数。\n\n` +
      '请先确认这是你要用的那个渠道。替换后本插件不会自动保存，你仍需要在柏宝绘里点一次「完成」。';
    detail.appendChild(warn);

    const ul = el('div', 'bbo-confirm-list');
    for (const it of changed) {
      ul.appendChild(el('div', 'bbo-confirm-row', `${it.label}：${it.current} → ${it.suggest}`));
    }
    detail.appendChild(ul);

    const btns = el('div', 'bbo-confirm-btns');
    const cancel = el('button', null, '取消');
    const ok = el('button', 'primary', '确认替换');
    cancel.type = 'button';
    ok.type = 'button';
    btns.append(cancel, ok);
    detail.appendChild(btns);

    cancel.addEventListener('click', paintChannels);
    ok.addEventListener('click', () => {
      const res = applySuggestions(channel.id, changed);
      detail.innerHTML = '';
      detail.appendChild(el('div', 'bbo-detail-title', res.ok ? '替换成功' : '替换失败'));
      const h = el('div', `bbo-hint ${res.ok ? 'good' : 'bad'}`);
      h.style.whiteSpace = 'pre-wrap';
      h.textContent = res.ok
        ? `已修改 ${res.changed} 项。\n\n请回到柏宝绘渠道设置页点一次「完成」保存，否则不会生效。`
        : res.message || '无法修改，请手动在柏宝绘里调整。';
      detail.appendChild(h);

      const back = el('button', null, '返回');
      back.type = 'button';
      back.style.marginTop = '12px';
      back.addEventListener('click', paintChannels);
      detail.appendChild(back);
    });
  }

  function paint() {
    if (mode === 'channels') {
      paintChannels();
      return;
    }

    const recs = getRecords();
    const st = getStats();
    sum.textContent = `共 ${st.total} 次，异常 ${st.failed} 次`;

    list.innerHTML = '';
    if (!recs.length) {
      list.appendChild(
        el(
          'div',
          'bbo-empty',
          '还没有记录。\n去柏宝绘那边出一次图，这里就会自动出现。',
        ),
      );
      renderDetail(detail, null);
      return;
    }

    for (const rec of recs) {
      const row = el('div', 'bbo-row');
      row.dataset.time = String(rec.time);
      if (rec.time === currentTime) row.classList.add('on');

      const top = el('div', 'bbo-row-top');
      const s = statusOf(rec);
      top.appendChild(el('span', `bbo-dot ${s.cls}`));
      top.appendChild(el('span', null, s.text));
      if (rec.isBaiBai) top.appendChild(el('span', 'bbo-tag', '柏宝绘'));
      top.appendChild(el('span', 'bbo-tm', fmtTime(rec.time)));
      row.appendChild(top);

      const sub = el(
        'div',
        'bbo-row-sub',
        `${rec.params.model || '未记录'} · 温度 ${rec.params.temperature ?? '—'} · 输出 ${rec.outputLength} 字`,
      );
      row.appendChild(sub);

      row.addEventListener('click', () => {
        currentTime = rec.time;
        list.querySelectorAll('.bbo-row').forEach((n) => n.classList.remove('on'));
        row.classList.add('on');
        renderDetail(detail, rec);
      });

      list.appendChild(row);
    }

    const picked = recs.find((r) => r.time === currentTime) || null;
    renderDetail(detail, picked);
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  }
  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  x.addEventListener('click', close);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  document.addEventListener('keydown', onKey);

  refreshBtn.addEventListener('click', paint);
  clearBtn.addEventListener('click', () => {
    clearRecords();
    currentTime = null;
    paint();
  });

  // 页签切换
  tabLog.addEventListener('click', () => {
    if (mode === 'log') return;
    mode = 'log';
    tabLog.classList.add('on');
    tabCh.classList.remove('on');
    list.style.display = '';
    clearBtn.style.display = '';
    refreshBtn.style.display = '';
    paint();
  });
  tabCh.addEventListener('click', () => {
    if (mode === 'channels') return;
    mode = 'channels';
    tabCh.classList.add('on');
    tabLog.classList.remove('on');
    // 渠道建议页不需要清空按钮
    clearBtn.style.display = 'none';
    paintChannels();
  });

  // 新记录进来时自动刷新列表
  const onNew = () => paint();
  window.addEventListener('bbi-optimize:record', onNew);

  /**
   * 用实测像素给遮罩和面板定尺寸。
   * 不用 vh / dvh / 百分比：酒馆内嵌布局和手机地址栏会让这些值算错，
   * 之前面板被“压扁”就是因为这个。
   */
  function layout() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return;

    mask.style.width = `${vw}px`;
    mask.style.height = `${vh}px`;

    const isPhone = vw <= 700;

    if (isPhone) {
      mask.style.padding = '0px';
      panel.style.width = `${vw}px`;
      panel.style.height = `${vh}px`;
      panel.style.maxWidth = 'none';
      panel.style.maxHeight = 'none';
      panel.style.borderRadius = '0px';
    } else {
      const pad = 16;
      mask.style.padding = `${pad}px`;
      const w = Math.min(860, vw - pad * 2);
      const h = Math.min(620, vh - pad * 2);
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
      panel.style.maxWidth = `${vw - pad * 2}px`;
      panel.style.maxHeight = `${vh - pad * 2}px`;
      panel.style.borderRadius = '10px';
    }
  }

  layout();

  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  mask.appendChild(panel);
  document.body.appendChild(mask);
  // 挂进 DOM 后再量一次，拿到真实布局后的尺寸
  requestAnimationFrame(layout);
  paint();

  // 关闭时解绑
  const origClose = close;
  x.removeEventListener('click', origClose);
  x.addEventListener('click', () => {
    window.removeEventListener('bbi-optimize:record', onNew);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    origClose();
  });
}

/* ===== src/index.js ===== */
/**
 * 柏宝绘优化 · 入口
 *
 * 在柏宝绘的请求旁边观察，记录下来，出问题时告诉你原因。
 * 不修改柏宝绘的请求、响应或行为。
 *
 * 唯一会写入的是「一键替换」功能，而且必须用户二次确认，
 * 并且只改数值参数，绝不碰 API 地址、密钥、模型名。
 *
 * 注意：打包时本文件与其它模块会被拼进同一个作用域，
 * 所以模块级常量都加了 Opt 前缀，避免重名。
 */



const OPT_NAME = '柏宝绘优化';
const OPT_BTN_CLASS = 'bbo-trigger';
const OPT_STYLE_ID = 'bbo-entry-style';
const OPT_BALL_KEY = 'bbo.ball.visible';

const OPT_ICON = `
<svg viewBox="0 0 24 24" width="18" height="18" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M3 12h4l3 8 4-16 3 8h4"/>
</svg>
`;

/** 只补横排规则，配色交回酒馆原生样式。 */
const OPT_CSS = `
#bbo-settings-block .menu_button{
  writing-mode:horizontal-tb;
  text-orientation:mixed;
  white-space:nowrap;
  word-break:keep-all;
}
#bbo-settings-block .bbo-check-row{
  display:flex;
  align-items:center;
  gap:8px;
  margin:6px 0 10px;
  font-size:13px;
  cursor:pointer;
}
#bbo-settings-block .bbo-check-row input{
  margin:0;
  width:16px;
  height:16px;
  cursor:pointer;
}
`;

function ensureOptStyle() {
  if (document.getElementById(OPT_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = OPT_STYLE_ID;
  s.textContent = OPT_CSS;
  document.head.appendChild(s);
}

function addMenuButton() {
  if (document.querySelector(`.${OPT_BTN_CLASS}`)) return;
  const host =
    document.querySelector('#extensionsMenu') ||
    document.querySelector('#extensions_menu') ||
    document.querySelector('#extensions-settings-button')?.parentElement;
  if (!host) return;

  const btn = document.createElement('div');
  btn.className = `list-group-item flex-container flexGap5 interactable ${OPT_BTN_CLASS}`;
  btn.tabIndex = 0;
  btn.title = OPT_NAME;
  btn.innerHTML = `${OPT_ICON}<span>${OPT_NAME}</span>`;
  btn.addEventListener('click', () => {
    openPanel();
    try {
      window.SillyTavern?.getContext?.()?.hideExtensionsMenu?.();
    } catch {
      /* 忽略 */
    }
  });

  host.appendChild(btn);
}

function addSettingsBlock() {
  const container =
    document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
  if (!container || document.querySelector('#bbo-settings-block')) return;

  ensureOptStyle();

  const block = document.createElement('div');
  block.id = 'bbo-settings-block';
  block.className = 'inline-drawer';
  // 不依赖酒馆的 inline-drawer 折叠行为，自己管展开状态，
  // 避免手机端内容被折叠容器压扁成空白。
  block.innerHTML = `
    <div class="inline-drawer-toggle inline-drawer-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
      <b>${OPT_NAME}</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content bbo-content" style="display:none;padding:10px 0;height:auto;overflow:visible;">
      <div style="opacity:.72;font-size:12px;line-height:1.7;margin-bottom:10px;">
        记录柏宝绘每次出图的请求与返回，失败时告诉你原因。只观察，不改动柏宝绘的设置。
      </div>
      <label class="bbo-check-row" style="display:flex;align-items:center;gap:8px;margin:6px 0 10px;font-size:13px;cursor:pointer;white-space:nowrap;">
        <input type="checkbox" id="bbo-ball-check" style="margin:0;width:16px;height:16px;flex:0 0 16px;cursor:pointer;">
        <span>显示悬浮球</span>
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        <input type="button" class="menu_button" id="bbo-open-btn" value="打开诊断面板"
               style="writing-mode:horizontal-tb;white-space:nowrap;word-break:keep-all;">
      </div>
    </div>
  `;

  // 自己实现展开/收起，展开时用 px 让高度自然撑开
  const content = block.querySelector('.bbo-content');
  const toggle = block.querySelector('.inline-drawer-toggle');
  const icon = block.querySelector('.inline-drawer-icon');
  toggle.addEventListener('click', () => {
    const open = content.style.display !== 'none';
    content.style.display = open ? 'none' : 'block';
    content.style.height = 'auto';
    if (icon) {
      icon.classList.toggle('down', !open);
      icon.style.transform = open ? 'rotate(-90deg)' : '';
    }
  });

  const check = block.querySelector('#bbo-ball-check');
  check.checked = isBallEnabled();
  check.addEventListener('change', () => {
    setBallEnabled(check.checked);
  });

  block.querySelector('#bbo-open-btn').addEventListener('click', () => openPanel());
  container.appendChild(block);
}

function boot() {
  addMenuButton();
  addSettingsBlock();
  // 悬浮球按用户的选择挂载，默认开
  mountFloatBall();
}

function bootOnce() {
  try {
    boot();
  } catch (err) {
    console.debug('[柏宝绘优化] 挂载跳过', err);
  }
}

// 先装监听，越早越好，确保能捕获到柏宝绘的请求。
try {
  installHook();
} catch (err) {
  console.error('[柏宝绘优化] 监听安装失败', err);
}

// 悬浮球点了要能打开面板
window.addEventListener('bbo-open-panel', () => {
  try {
    openPanel();
  } catch (err) {
    console.debug('[柏宝绘优化] 打开面板失败', err);
  }
});

// 有失败记录时给悬浮球亮个红点
window.addEventListener('bbi-optimize:record', (e) => {
  try {
    if (e?.detail?.ok === false) flashBallAlert();
  } catch {
    /* 忽略 */
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootOnce, { once: true });
} else {
  bootOnce();
}

// 不用定时器轮询，只在酒馆明确发出事件时补挂一次。
for (const evt of ['app_ready', 'chat_changed', 'extensions_loaded', 'settings_loaded']) {
  try {
    window.SillyTavern?.getContext?.()?.eventSource?.on?.(evt, bootOnce);
  } catch {
    /* 事件接口不可用就忽略 */
  }
}

})();
