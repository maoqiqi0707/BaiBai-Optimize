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

import { installHook } from './monitor.js';
import { openPanel } from './panel.js';
import {
  mountFloatBall,
  unmountFloatBall,
  isBallEnabled,
  setBallEnabled,
  flashBallAlert,
} from './floatball.js';

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
