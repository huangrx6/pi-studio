'use strict';

const protocol = 'pi-studio:ext-view:v1';
const choices = document.querySelector('fieldset');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const lid = document.querySelector('#lid');
const lidSwitch = document.querySelector('#lid-switch');
const lidStatus = document.querySelector('#lid-status');
const lidLabels = {
  off: '临时更改整机休眠，需管理员授权。电池电量降至 20% 时自动关闭。',
  authorizing: '等待 macOS 管理员授权…',
  armed: '本次已授权，随上方模式生效。',
  active: '合盖运行已生效，电池电量降至 20% 时自动关闭。',
  external: '系统已由其他设置保持唤醒。',
  stopping: '正在释放本次合盖请求…',
};
let state;
let writable = false;
let pending = '';
let failure = '';
let requestNumber = 0;
let reportedHeight = 0;

function post(message) {
  window.parent.postMessage({ protocol, ...message }, '*');
}

function reportHeight() {
  // The first snapshot determines whether the lid controls occupy a row.
  if (!state && !failure) return;
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === reportedHeight) return;
  reportedHeight = height;
  post({ type: 'view:resize', height });
}

function render() {
  const error = failure || state?.error || '';
  status.textContent = error || state?.label || '正在读取状态…';
  status.dataset.active = String(Boolean(state?.active));
  status.dataset.error = String(Boolean(error));
  retry.hidden = !error;
  choices.disabled = !writable || !state;
  for (const input of choices.elements) input.checked = input.value === state?.mode;
  lid.hidden = !state?.lid;
  if (state?.lid) {
    lidSwitch.checked = state.lid.enabled;
    lidSwitch.disabled = !writable || state.lid.phase === 'stopping';
    lidStatus.textContent = state.lid.message || lidLabels[state.lid.phase];
  }
}

function invoke(method, params) {
  // Keep the visible selection on the last confirmed mode until the host replies.
  render();
  if (pending || !writable) return;
  pending = String(++requestNumber);
  post({ type: 'view:invoke', requestId: pending, method, params });
}

choices.addEventListener('change', event => invoke('setMode', { mode: event.target.value }));
lidSwitch.addEventListener('change', () => invoke('setLidEnabled', { enabled: lidSwitch.checked }));
retry.addEventListener('click', () => {
  if (writable && state) invoke('setMode', { mode: state.mode });
  else post({ type: 'view:retry' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') post({ type: 'view:close' });
});
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window.parent || message?.protocol !== protocol) return;
  if (message.type === 'host:context') {
    document.documentElement.style.colorScheme = message.theme;
    for (const [name, value] of Object.entries(message.tokens)) {
      document.documentElement.style.setProperty(name, value);
    }
  } else if (message.type === 'host:snapshot') {
    writable = message.invocable;
    failure = message.error;
    state = message.data;
    render();
    reportHeight();
  } else if (message.type === 'host:response' && message.requestId === pending) {
    pending = '';
    failure = message.ok ? '' : message.error;
    if (message.ok) state = message.result;
    render();
  }
});
post({ type: 'view:ready' });
new ResizeObserver(reportHeight).observe(document.body);
