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
export function isBallEnabled() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return true;
    return v === '1';
  } catch {
    return true;
  }
}

/** 设置悬浮球显示与否。 */
export function setBallEnabled(on) {
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
export function mountFloatBall() {
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
export function unmountFloatBall() {
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
export function flashBallAlert() {
  const ball = document.getElementById(FLOAT_ID);
  if (!ball) return;
  ball.classList.add('has-alert');
}
