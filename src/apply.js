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
export function escapeHtml(s) {
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
export function applySuggestions(channelId, items) {
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
