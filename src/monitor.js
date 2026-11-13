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
export function installHook() {
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
export function getRecords() {
  return records.slice();
}

/** 清空记录。 */
export function clearRecords() {
  records.length = 0;
}

/** 统计汇总。 */
export function getStats() {
  const total = records.length;
  const failed = records.filter((r) => r.ok === false).length;
  const reasons = {};
  for (const r of records) {
    if (r.ok === false) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  return { total, failed, ok: total - failed, reasons };
}
