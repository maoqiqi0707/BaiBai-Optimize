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
export function readChannels() {
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
export function buildSuggestions(channel) {
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
export function buildExcludeHint(channel) {
  if (!channel) return '';
  const has = channel.excludeParams;
  if (has) return `当前已排除：${has}。如果仍然失败，可以再试加 reasoning_effort。`;
  return '如果调完参数还是失败，可以往这里填 reasoning_effort 试试，用来把思考参数从请求里删掉。';
}
