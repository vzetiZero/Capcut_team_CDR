import { createPageSession } from './cdp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DETECT = `(function () {
  const visible = (el) => Boolean(el) && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  if (visible(document.querySelector('input[autocomplete="one-time-code"], input[name="code"]'))) return 'verify';
  if (visible(document.querySelector('iframe[src*="captcha"], iframe[src*="verify"]'))) return 'captcha';
  if (visible(document.querySelector('button.JoinPanelBtn-Ffvlan, .JoinPanel-Y4S5YH button'))) return 'join';
  if (visible(document.querySelector('input[name="password"]'))) return 'password';
  if (visible(document.querySelector('input[name="username"]'))) return 'email-input';
  const label = [...document.querySelectorAll('span.lv_third_part_sign_in_expand-label')]
    .find((el) => el.textContent.trim().toLowerCase().includes('continue with email'));
  if (visible(label)) return 'email-entry';
  return '';
})()`;

const CLICK_EMAIL_ENTRY = `(function () {
  const label = [...document.querySelectorAll('span.lv_third_part_sign_in_expand-label')]
    .find((el) => el.textContent.trim().toLowerCase().includes('continue with email'));
  if (!label) return false;
  const target = label.closest('button, [role="button"], a') || label;
  target.click();
  return true;
})()`;

const CLICK_CONTINUE = `(function () {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find((item) => item.className.includes('lv_email_entry_view-btn')
      && item.textContent.trim().toLowerCase() === 'continue')
    || buttons.find((item) => item.textContent.trim().toLowerCase() === 'continue');
  if (!button) return false;
  button.click();
  return true;
})()`;

const CLICK_SIGN_IN = `(function () {
  const buttons = [...document.querySelectorAll('button')];
  const button = buttons.find((item) => item.className.includes('lv_sign_in_panel_wide-sign-in-button')
      && item.textContent.trim().toLowerCase() === 'sign in')
    || buttons.find((item) => item.textContent.trim().toLowerCase() === 'sign in');
  if (!button) return false;
  button.click();
  return true;
})()`;

const CLICK_SUBMIT = `(function () {
  const visible = (el) => Boolean(el) && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const button = [...document.querySelectorAll('button.JoinPanelBtn-Ffvlan, .JoinPanel-Y4S5YH button')]
    .find(visible);
  if (!button) return false;
  button.click();
  return true;
})()`;

const JOIN_GONE = `(function () {
  const panel = document.querySelector('.JoinPanel-Y4S5YH');
  return !panel || panel.getClientRects().length === 0;
})()`;

function fillExpression(name, value) {
  const json = JSON.stringify(value);
  return `(function () {
    const input = document.querySelector('input[name="${name}"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${json});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    return input.value === ${json};
  })()`;
}

function isContextError(error) {
  return /context|destroyed|detached|target closed|Session closed/i.test(error.message);
}

async function evaluate(session, expression) {
  try {
    return await session.evaluate(expression);
  } catch (error) {
    if (isContextError(error)) return null;
    throw error;
  }
}

async function waitState(session, wanted, timeoutMs, label, log) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await evaluate(session, DETECT);
    if (state === 'verify' || state === 'captcha') return state;
    if (state && wanted.includes(state)) return state;
    if (state && state !== last) {
      last = state;
      log(`Trạng thái trang: ${state}`);
    }
    await sleep(400);
  }
  throw new Error(`Hết thời gian chờ ${label}.`);
}

async function click(session, expression, label) {
  const clicked = await evaluate(session, expression);
  if (!clicked) throw new Error(`Không tìm thấy nút ${label} để bấm.`);
}

async function waitJoinDone(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(session, JOIN_GONE)) return;
    await sleep(400);
  }
  throw new Error('Đã bấm Submit nhưng form Join space vẫn còn — kiểm tra thủ công.');
}

export async function runLoginFlow({ cdpPort, email, password, log = () => {} }) {
  const session = await createPageSession(cdpPort);
  try {
    log('Đang chờ trang đăng nhập...');
    let state = await waitState(
      session,
      ['email-entry', 'email-input', 'password', 'join'],
      90000,
      'trang đăng nhập CapCut',
      log
    );

    if (state === 'verify') throw new Error('CapCut yêu cầu mã xác minh/OTP — cần xử lý thủ công.');
    if (state === 'captcha') throw new Error('CapCut hiện captcha — cần xử lý thủ công.');

    if (state === 'email-entry') {
      await click(session, CLICK_EMAIL_ENTRY, '"Continue with email"');
      log('Đã bấm "Continue with email"');
      state = await waitState(session, ['email-input', 'password', 'join'], 30000, 'ô nhập email', log);
    }

    if (state === 'verify') throw new Error('CapCut yêu cầu mã xác minh/OTP — cần xử lý thủ công.');
    if (state === 'captcha') throw new Error('CapCut hiện captcha — cần xử lý thủ công.');

    if (state === 'email-input') {
      const filled = await evaluate(session, fillExpression('username', email));
      if (!filled) throw new Error('Không điền được email vào form đăng nhập.');
      log('Đã điền email');
      await sleep(250);
      await click(session, CLICK_CONTINUE, 'Continue');
      log('Đã bấm Continue');
      state = await waitState(session, ['password', 'join'], 45000, 'ô nhập mật khẩu', log);
    }

    if (state === 'verify') throw new Error('CapCut yêu cầu mã xác minh/OTP — cần xử lý thủ công.');
    if (state === 'captcha') throw new Error('CapCut hiện captcha — cần xử lý thủ công.');

    if (state === 'password') {
      const filled = await evaluate(session, fillExpression('password', password || ''));
      if (!filled) throw new Error('Không điền được mật khẩu vào form đăng nhập.');
      log('Đã điền mật khẩu');
      await sleep(250);
      await click(session, CLICK_SIGN_IN, 'Sign in');
      log('Đã bấm Sign in');
      state = await waitState(session, ['join'], 45000, 'form xác minh Join space', log);
    }

    if (state === 'verify') throw new Error('CapCut yêu cầu mã xác minh/OTP — cần xử lý thủ công.');
    if (state === 'captcha') throw new Error('CapCut hiện captcha — cần xử lý thủ công.');

    if (state === 'join') {
      await click(session, CLICK_SUBMIT, 'Submit');
      log('Đã bấm Submit, chờ xác nhận vào space...');
      await waitJoinDone(session, 20000);
      log('THÀNH CÔNG: đã đăng nhập và Submit join space.');
      return { ok: true };
    }

    throw new Error(`Trạng thái trang không xác định: ${state || 'trống'}.`);
  } finally {
    session.close();
  }
}
