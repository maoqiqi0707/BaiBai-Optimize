/**
 * 诊断面板 · 界面
 *
 * 两个页签：请求记录、渠道建议。
 * 记录页只读展示；建议页给出推荐值，一键替换必须二次确认。
 */

import { getRecords, clearRecords, getStats } from './monitor.js';
import { readChannels, buildSuggestions, buildExcludeHint } from './channels.js';
import { applySuggestions, escapeHtml } from './apply.js';

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
export function openPanel() {
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
