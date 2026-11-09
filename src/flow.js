import fs from 'node:fs';
import path from 'node:path';
import { createPageSession } from './cdp.js';
import { ROOT } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CLOUD_URL = /^https?:\/\/(?:www\.)?capcut\.com\/my-cloud\//i;
const DEBUG_DIR = path.join(ROOT, 'data', 'debug');

// CapCut hiện lỗi sai mật khẩu/tài khoản ngay trên panel đăng nhập; nhận ra sớm để báo đúng
// nguyên nhân thay vì chờ hết 45 giây rồi báo "hết thời gian chờ".
const LOGIN_ERROR_PATTERN =
  '/(incorrect (?:email or )?password|wrong password|invalid (?:email or )?password|password is incorrect|too many (?:attempts|requests|tries)|something went wrong|unknown error|sai m[aậ]t kh[aẩ]u|kh[oô]ng đ[uú]ng|qu[aá] nhi[eề]u l[aầ]n|密码错误|账号或密码错误|尝试次数过多|操作过于频繁)/i';

async function fetchJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

const BLOCKED_TEXT = /can[’']?t join space|unusual activities|không thể tham gia/i;

function joinRetryError() {
  const error = new Error('Tài khoản chưa join được: "Can’t submit request" — đã đưa lại vào hàng đợi để chạy lần sau.');
  error.code = 'join-retry';
  return error;
}

// CapCut đổi hậu tố hash của class sau mỗi lần deploy (JoinPanel-Y4S5YH, JoinPanelBtn-Ffvlan...),
// nên ngoài selector cũ còn dò theo tiền tố class và theo chữ hiển thị trên nút.
const DETECT = `(function () {
  const visible = (el) => Boolean(el) && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const pageText = () => ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
  if (/^https?:\\/\\/(?:www\\.)?capcut\\.com\\/my-cloud\\//i.test(location.href)) return 'cloud';
  if (visible(document.querySelector('.JoinErrPanelTitle-GWfMxQ, [class*="JoinErrPanel"]'))) return 'join-retry';
  if (visible(document.querySelector('input[autocomplete="one-time-code"], input[name="code"], input[name="otp"]'))) return 'verify';
  if (visible(document.querySelector('iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="secsdk"], [class*="captcha"], [id*="captcha"]'))) return 'captcha';
  if (${LOGIN_ERROR_PATTERN}.test(pageText())) return 'login-error';
  if (visible(document.querySelector('button.JoinPanelBtn-Ffvlan, .JoinPanel-Y4S5YH button, [class*="JoinPanel"] button, [class*="JoinPanel"] [role="button"]'))) return 'join';
  if (visible(document.querySelector('input[name="password"], input[type="password"]'))) return 'password';
  if (visible(document.querySelector('input[name="username"], input[name="email"], input[type="email"]'))) return 'email-input';
  const label = [...document.querySelectorAll('span.lv_third_part_sign_in_expand-label')]
    .find((el) => el.textContent.trim().toLowerCase().includes('continue with email'));
  if (visible(label)) return 'email-entry';
  const mailButton = [...document.querySelectorAll('button, [role="button"], a')]
    .find((el) => visible(el) && /^continue with email$/i.test((el.textContent || '').trim()));
  if (mailButton) return 'email-entry';
  return '';
})()`;

// Ảnh chụp trạng thái trang lúc lỗi: URL, tiêu đề, chữ đang hiển thị và state nhận diện.
const PAGE_INFO = `(function () {
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim();
  return {
    state: ${DETECT},
    href: location.href,
    title: document.title,
    text: text.slice(0, 500)
  };
})()`;

const CLICK_EMAIL_ENTRY = `(function () {
  const visible = (el) => Boolean(el) && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const label = [...document.querySelectorAll('span.lv_third_part_sign_in_expand-label')]
    .find((el) => el.textContent.trim().toLowerCase().includes('continue with email'))
    || [...document.querySelectorAll('button, [role="button"], a')]
      .find((el) => visible(el) && /^continue with email$/i.test((el.textContent || '').trim()));
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
  const panelButton = [...document.querySelectorAll('button.JoinPanelBtn-Ffvlan, .JoinPanel-Y4S5YH button, [class*="JoinPanel"] button, [class*="JoinPanel"] [role="button"]')]
    .find(visible);
  const byText = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .find((el) => /^(submit|join|join space|tham gia|gửi yêu cầu)$/i.test((el.textContent || '').trim()));
  const button = panelButton || byText;
  if (!button) return false;
  button.click();
  return true;
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

async function evaluateLoose(session, expression) {
  try {
    return await session.evaluate(expression);
  } catch (error) {
    if (isContextError(error) || /CDP timeout/i.test(error.message)) return null;
    throw error;
  }
}

async function pageSnapshot(session) {
  const info = await evaluateLoose(session, PAGE_INFO);
  return info && typeof info === 'object' ? info : null;
}

function timeoutError(label, snapshot, lastState) {
  const parts = [];
  if (snapshot?.href) parts.push(`URL: ${snapshot.href}`);
  const state = snapshot?.state || lastState;
  if (state) parts.push(`trạng thái: ${state}`);
  if (snapshot?.title) parts.push(`tiêu đề: ${snapshot.title}`);
  if (snapshot?.text) parts.push(`trang: "${snapshot.text.slice(0, 200)}"`);
  const details = parts.length ? ` (${parts.join(' · ')})` : '';
  return new Error(`Hết thời gian chờ ${label}.${details}`);
}

async function waitState(session, wanted, timeoutMs, label, log) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const state = await evaluateLoose(session, DETECT);
    if (['verify', 'captcha', 'join-retry', 'login-error'].includes(state)) return state;
    if (state && wanted.includes(state)) return state;
    if (state && state !== last) {
      last = state;
      log(`Trạng thái trang: ${state}`);
    }
    await sleep(400);
  }

  const snapshot = await pageSnapshot(session);
  if (snapshot) {
    log(`Hết giờ chờ ${label}: ${snapshot.href || '(không rõ URL)'}`
      + `${snapshot.state ? ` · trạng thái ${snapshot.state}` : ''}`
      + `${snapshot.text ? ` · "${snapshot.text.slice(0, 160)}"` : ''}`);
  }
  throw timeoutError(label, snapshot, last);
}

async function click(session, expression, label) {
  const clicked = await evaluate(session, expression);
  if (!clicked) throw new Error(`Không tìm thấy nút ${label} để bấm.`);
}

async function cloudTabUrl(cdpPort) {
  try {
    const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const tab = targets.find((target) => target.type === 'page' && CLOUD_URL.test(target.url || ''));
    return tab ? tab.url : null;
  } catch {
    return null;
  }
}

const DISMISS_OK = `(function () {
  const visible = (el) => Boolean(el) && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
  const button = [...document.querySelectorAll('button, [role="button"]')]
    .find((el) => visible(el) && el.textContent.trim().toLowerCase() === 'ok');
  if (!button) return false;
  button.click();
  return true;
})()`;

async function waitCloud(cdpPort, session, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs;
  const probe = `(function () {
    const errorTitle = document.querySelector('.JoinErrPanelTitle-GWfMxQ');
    return {
      href: location.href,
      blocked: ${BLOCKED_TEXT}.test(document.body ? document.body.innerText : ''),
      retry: Boolean(errorTitle && errorTitle.getClientRects().length > 0)
    };
  })()`;
  let last = '';
  let blockedNotice = false;
  while (Date.now() < deadline) {
    const info = await evaluateLoose(session, probe);
    const href = info?.href || '';
    if (href && href !== last) {
      last = href;
      log(`URL hiện tại: ${href}`);
    }
    if (CLOUD_URL.test(href)) return href;
    if (info?.retry) throw joinRetryError();
    if (info?.blocked && !blockedNotice) {
      blockedNotice = true;
      log('Trang báo "Can’t join space" — bấm OK và tiếp tục chờ my-cloud...');
      await evaluateLoose(session, DISMISS_OK);
    }
    const tabUrl = await cloudTabUrl(cdpPort);
    if (tabUrl) {
      if (tabUrl !== last) log(`URL hiện tại: ${tabUrl}`);
      return tabUrl;
    }
    await sleep(500);
  }
  throw new Error(blockedNotice
    ? 'Đã bấm Submit, CapCut báo "Can’t join space" và chưa chuyển về my-cloud — kiểm tra thủ công.'
    : 'Đã bấm Submit nhưng chưa chuyển về my-cloud — kiểm tra thủ công.');
}

async function ensureNoBlock(session, state) {
  if (state === 'verify') throw new Error('CapCut yêu cầu mã xác minh/OTP — cần xử lý thủ công.');
  if (state === 'captcha') throw new Error('CapCut hiện captcha — cần xử lý thủ công.');
  if (state === 'join-retry') throw joinRetryError();
  if (state === 'login-error') {
    const snapshot = await pageSnapshot(session);
    const detail = snapshot?.text
      ? ` — trang báo: "${snapshot.text.slice(0, 220)}"`
      : ' (không đọc được nội dung trang)';
    throw new Error(`CapCut báo lỗi đăng nhập${detail}`);
  }
}

// Lưu ảnh chụp + nội dung trang lúc lỗi để xem lại sau khi profile tạm đã bị xoá.
async function saveFailureArtifacts(session, error) {
  let base = null;
  try {
    const snapshot = await pageSnapshot(session);
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    base = path.join(DEBUG_DIR, `fail-${stamp}`);
    fs.writeFileSync(
      `${base}.json`,
      `${JSON.stringify({ at: new Date().toISOString(), error: error.message, page: snapshot || null }, null, 2)}\n`,
      'utf8'
    );
    const png = await session.screenshot?.();
    if (png) fs.writeFileSync(`${base}.png`, Buffer.from(png, 'base64'));
    return base;
  } catch {
    return base;
  }
}

async function cloudSuccess(session, cdpPort, log) {
  const url = (await evaluateLoose(session, 'location.href'))
    || (await cloudTabUrl(cdpPort))
    || 'capcut.com/my-cloud';
  log(`THÀNH CÔNG: đã vào my-cloud (${url}).`);
  return { ok: true, url };
}

export async function runLoginFlow({ cdpPort, email, password, teamUrl = '', log = () => {} }) {
  const session = await createPageSession(cdpPort, { startUrl: teamUrl });
  try {
    // Chrome mở kèm link team, nhưng nếu tab vẫn là about:blank (link không mở được,
    // Chrome tạo tab trống) thì tự điều hướng lại để flow không chờ vô ích.
    if (teamUrl) {
      const href = await evaluateLoose(session, 'location.href');
      if (!href || href === 'about:blank') {
        log(`Tab đang trống — mở lại link team: ${teamUrl}`);
        await session.navigate(teamUrl);
        await sleep(600);
      }
    }

    log('Đang chờ trang đăng nhập...');
    let state = await waitState(
      session,
      ['email-entry', 'email-input', 'password', 'join', 'cloud'],
      90000,
      'trang đăng nhập CapCut',
      log
    );
    await ensureNoBlock(session, state);
    if (state === 'cloud') return cloudSuccess(session, cdpPort, log);

    if (state === 'email-entry') {
      await click(session, CLICK_EMAIL_ENTRY, '"Continue with email"');
      log('Đã bấm "Continue with email"');
      state = await waitState(session, ['email-input', 'password', 'join', 'cloud'], 30000, 'ô nhập email', log);
      await ensureNoBlock(session, state);
      if (state === 'cloud') return cloudSuccess(session, cdpPort, log);
    }

    if (state === 'email-input') {
      const filled = await evaluate(session, fillExpression('username', email));
      if (!filled) throw new Error('Không điền được email vào form đăng nhập.');
      log('Đã điền email');
      await sleep(250);
      await click(session, CLICK_CONTINUE, 'Continue');
      log('Đã bấm Continue');
      state = await waitState(session, ['password', 'join', 'cloud'], 45000, 'ô nhập mật khẩu', log);
      await ensureNoBlock(session, state);
      if (state === 'cloud') return cloudSuccess(session, cdpPort, log);
    }

    if (state === 'password') {
      const filled = await evaluate(session, fillExpression('password', password || ''));
      if (!filled) throw new Error('Không điền được mật khẩu vào form đăng nhập.');
      log('Đã điền mật khẩu');
      await sleep(250);
      await click(session, CLICK_SIGN_IN, 'Sign in');
      log('Đã bấm Sign in');
      state = await waitState(session, ['join', 'cloud'], 45000, 'form xác minh Join space', log);
      await ensureNoBlock(session, state);
      if (state === 'cloud') return cloudSuccess(session, cdpPort, log);
    }

    if (state === 'join') {
      await click(session, CLICK_SUBMIT, 'Submit');
      log('Đã bấm Submit, chờ chuyển về my-cloud...');
      const url = await waitCloud(cdpPort, session, 60000, log);
      log(`THÀNH CÔNG: đã vào my-cloud (${url}).`);
      return { ok: true, url };
    }

    throw new Error(`Trạng thái trang không xác định: ${state || 'trống'}.`);
  } catch (error) {
    if (error.code !== 'join-retry') {
      const base = await saveFailureArtifacts(session, error);
      if (base) {
        error.message = `${error.message} [ảnh + chi tiết: ${base}.png]`;
        log(`Đã lưu ảnh trạng thái lỗi: ${base}.png`);
      }
    }
    throw error;
  } finally {
    session.close();
  }
}
