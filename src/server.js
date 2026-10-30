import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { accountProfileName, parseAccounts } from './accounts.js';
import { describeProxy, getChromeInfo, loadConfig, parseProxy, ROOT, saveConfig } from './config.js';
import { runLoginFlow } from './flow.js';
import { clearCompleted, completedCount, isCompleted, loadHistory, markCompleted } from './history.js';
import { computeLayout, getWorkArea } from './layout.js';
import { closeAll, closeProfile, deleteProfileData, getRunning, isRunning, launchProfile } from './manager.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css']
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const queue = {
  active: false,
  pumping: false,
  closeOnStop: false,
  accounts: [],
  concurrency: 3,
  headless: false,
  ephemeral: true,
  teamUrl: '',
  startedAt: null,
  completedAt: null
};

function queueCounts() {
  const counts = { total: 0, queued: 0, launching: 0, running: 0, closed: 0, error: 0, stopped: 0, completed: 0 };
  for (const entry of queue.accounts) {
    counts.total += 1;
    if (counts[entry.status] !== undefined) counts[entry.status] += 1;
  }
  return counts;
}

function publicQueue() {
  return {
    active: queue.active,
    concurrency: queue.concurrency,
    headless: queue.headless,
    ephemeral: queue.ephemeral,
    teamUrl: queue.teamUrl,
    startedAt: queue.startedAt,
    completedAt: queue.completedAt,
    counts: queueCounts(),
    accounts: queue.accounts.map((entry) => ({
      id: entry.id,
      email: entry.email,
      name: entry.name,
      status: entry.status,
      error: entry.error || null,
      proxy: entry.proxyLabel || 'IP máy',
      cdpPort: entry.cdpPort || null,
      mcpFile: entry.mcpFile || null,
      position: entry.position || null,
      headless: entry.headless,
      profileDeleted: Boolean(entry.profileDeleted),
      cleanupError: entry.cleanupError || null,
      flow: entry.flow
        ? {
            status: entry.flow.status,
            step: entry.flow.step || null,
            message: entry.flow.message || null,
            startedAt: entry.flow.startedAt || null,
            finishedAt: entry.flow.finishedAt || null
          }
        : null,
      startedAt: entry.startedAt || null,
      closedAt: entry.closedAt || null
    }))
  };
}

function cleanupQueueEntry(entry) {
  if (!queue.ephemeral || entry.profileDeleted || entry.cleanupStarted) return;
  entry.cleanupStarted = true;
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    entry.cleanupError = err.message;
    return;
  }
  deleteProfileData(config, entry.name)
    .then(() => {
      entry.profileDeleted = true;
      entry.cleanupError = null;
    })
    .catch((err) => {
      entry.cleanupError = err.message;
    });
}

function finishQueueEntry(entry, status = 'closed') {
  entry.status = status;
  entry.slot = null;
  entry.closedAt = entry.closedAt || Date.now();
  entry.password = '';
  entry.proxy = null;
  if (entry.flow && entry.flow.status === 'running') {
    entry.flow.status = 'stopped';
    entry.flow.finishedAt = Date.now();
  }
  cleanupQueueEntry(entry);
}

function startEntryFlow(entry) {
  if (!entry.password) {
    entry.flow = {
      status: 'skipped',
      step: null,
      message: 'Không có mật khẩu — đăng nhập thủ công.',
      startedAt: Date.now(),
      finishedAt: Date.now()
    };
    return;
  }

  const flow = {
    status: 'running',
    step: 'Đang chờ trang đăng nhập...',
    message: null,
    startedAt: Date.now(),
    finishedAt: null
  };
  entry.flow = flow;

  runLoginFlow({
    cdpPort: entry.cdpPort,
    email: entry.email,
    password: entry.password,
    log: (step) => {
      if (entry.flow === flow) flow.step = step;
      console.log(`[flow ${entry.email}] ${step}`);
    }
  })
    .then(() => {
      if (entry.flow !== flow) return;
      entry.password = '';
      flow.status = 'success';
      flow.step = 'Hoàn tất';
      flow.message = 'Đã đăng nhập và Submit join space.';
      flow.finishedAt = Date.now();
      const recorded = markCompleted(entry.email);
      if (recorded) console.log(`[flow] Đã ghi nhận hoàn tất: ${entry.email}`);
      console.log(`[flow] THÀNH CÔNG: ${entry.email} (CDP :${entry.cdpPort})`);
      scheduleAutoClose(entry, flow);
    })
    .catch((err) => {
      if (entry.flow !== flow) return;
      entry.password = '';
      if (flow.status !== 'running') return;
      flow.status = 'error';
      flow.message = err.message;
      flow.finishedAt = Date.now();
      console.warn(`[flow] LỖI: ${entry.email}: ${err.message}`);
    });
}

function scheduleAutoClose(entry, flow) {
  if (!queue.ephemeral) return;
  setTimeout(async () => {
    if (entry.status !== 'running' || entry.flow !== flow || flow.status !== 'success') return;
    try {
      await closeProfile(entry.name);
      if (entry.flow !== flow) return;
      finishQueueEntry(entry, 'closed');
      reconcileQueue();
      console.log(`[flow] Đã đóng Chrome và xoá profile: ${entry.email}`);
    } catch (err) {
      console.warn(`[flow] Không tự đóng ${entry.email}: ${err.message}`);
    }
  }, 2000);
}

async function launchQueueEntry(entry, config) {
  const position = queue.headless
    ? null
    : computeLayout(queue.concurrency, getWorkArea(), config.window)[entry.slot] || null;

  if (queue.ephemeral) {
    try {
      await deleteProfileData(config, entry.name);
    } catch (err) {
      entry.cleanupError = err.message;
    }
  }

  const profile = {
    name: entry.name,
    email: entry.email,
    proxy: entry.proxy || null,
    proxyRaw: '',
    url: ''
  };

  const handle = await launchProfile(config, profile, {
    startUrl: queue.teamUrl,
    position,
    headless: queue.headless
  });

  entry.cdpPort = handle.cdpPort;
  entry.mcpFile = handle.mcpFile;
  entry.position = handle.position;
  entry.browser = handle.browser;
  entry.headless = Boolean(queue.headless);
  entry.startedAt = Date.now();
  entry.status = 'running';
  entry.error = null;
  entry.proxy = null;

  if (!queue.active && queue.closeOnStop) {
    await closeProfile(entry.name);
    finishQueueEntry(entry, 'closed');
  } else {
    startEntryFlow(entry);
  }
}

async function pumpQueue() {
  if (queue.pumping || !queue.active) return;
  queue.pumping = true;
  try {
    while (queue.active) {
      const activeEntries = queue.accounts.filter(
        (entry) => entry.status === 'launching' || entry.status === 'running'
      );
      if (activeEntries.length >= queue.concurrency) break;

      const entry = queue.accounts.find((item) => item.status === 'queued');
      if (!entry) break;

      const usedSlots = new Set(activeEntries.map((item) => item.slot));
      let slot = 0;
      while (usedSlots.has(slot)) slot += 1;

      entry.status = 'launching';
      entry.slot = slot;

      let config;
      try {
        config = loadConfig();
        await launchQueueEntry(entry, config);
      } catch (err) {
        entry.status = 'error';
        entry.error = err.message;
        entry.slot = null;
        entry.closedAt = Date.now();
        entry.password = '';
        entry.proxy = null;
        cleanupQueueEntry(entry);
      }
      await sleep(250);
    }
  } catch (err) {
    console.error(`[queue] ${err.message}`);
  } finally {
    queue.pumping = false;
  }
}

function reconcileQueue() {
  for (const entry of queue.accounts) {
    if (entry.status === 'running' && !isRunning(entry.name)) {
      finishQueueEntry(entry, 'closed');
    }
  }

  if (!queue.active) return;

  const activeCount = queue.accounts.filter(
    (entry) => entry.status === 'launching' || entry.status === 'running'
  ).length;
  const hasQueued = queue.accounts.some((entry) => entry.status === 'queued');

  if (!hasQueued && activeCount === 0) {
    queue.active = false;
    queue.completedAt = Date.now();
  } else if (hasQueued && activeCount < queue.concurrency) {
    pumpQueue();
  }
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Body quá lớn (tối đa 1 MB).');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicConfig(config) {
  return {
    window: config.window,
    useBundledChrome: config.useBundledChrome,
    chromePath: config.chromePath,
    uiPort: config.uiPort,
    basePort: config.basePort,
    startUrl: config.startUrl,
    teamUrl: config.startUrl,
    concurrency: config.concurrency,
    headless: config.headless,
    ephemeral: config.ephemeral,
    proxyEnabled: config.proxyEnabled,
    proxiesText: config.proxiesText,
    completedCount: completedCount(),
    chrome: getChromeInfo(config),
    screen: getWorkArea(),
    running: getRunning()
  };
}

function serveStatic(response, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) {
    sendJson(response, 404, { ok: false, error: 'Không tìm thấy.' });
    return;
  }
  const fullPath = path.join(PUBLIC_DIR, file);
  fs.readFile(fullPath, (err, content) => {
    if (err) {
      sendJson(response, 500, { ok: false, error: err.message });
      return;
    }
    response.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    response.end(content);
  });
}

async function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/styles.css')) {
    serveStatic(response, pathname);
    return;
  }

  if (request.method === 'GET' && (pathname === '/api/config' || pathname === '/api/status')) {
    const config = loadConfig();
    sendJson(response, 200, { ok: true, ...publicConfig(config), queue: publicQueue() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/config') {
    const body = await readJson(request);
    let updated;
    try {
      updated = saveConfig(body);
    } catch (err) {
      sendJson(response, 400, { ok: false, error: err.message });
      return;
    }
    sendJson(response, 200, { ok: true, ...publicConfig(updated), queue: publicQueue() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/queue/start') {
    if (queue.active) {
      sendJson(response, 409, { ok: false, error: 'Hàng đợi đang chạy. Dừng hàng đợi hiện tại trước.' });
      return;
    }

    const body = await readJson(request);
    const parsed = parseAccounts(body.accountsText);
    if (parsed.errors.length) {
      sendJson(response, 400, {
        ok: false,
        error: `Dòng ${parsed.errors[0].line}: ${parsed.errors[0].message}`,
        details: parsed.errors
      });
      return;
    }
    if (parsed.accounts.length === 0) {
      sendJson(response, 400, { ok: false, error: 'Chưa có tài khoản nào trong danh sách.' });
      return;
    }

    let updated;
    try {
      updated = saveConfig({
        teamUrl: body.teamUrl,
        concurrency: body.concurrency,
        headless: Boolean(body.headless),
        ephemeral: body.ephemeral,
        proxyEnabled: Boolean(body.proxyEnabled),
        proxiesText: body.proxiesText
      });
    } catch (err) {
      sendJson(response, 400, { ok: false, error: err.message });
      return;
    }

    let proxyPool = [];
    try {
      proxyPool = updated.proxyEnabled ? updated.proxies.map((line) => parseProxy(line)) : [];
    } catch (err) {
      sendJson(response, 400, { ok: false, error: `Proxy: ${err.message}` });
      return;
    }

    const history = loadHistory();
    let proxyIndex = 0;
    queue.accounts = parsed.accounts.map((account) => {
      const done = isCompleted(account.email, history);
      const proxy = done || proxyPool.length === 0
        ? null
        : proxyPool[proxyIndex++ % proxyPool.length];
      return {
        id: accountProfileName(account.email),
        name: accountProfileName(account.email),
        email: account.email,
        password: done ? '' : account.password,
        proxy,
        proxyLabel: describeProxy(proxy),
        status: done ? 'completed' : 'queued',
        slot: null,
        error: null,
        cdpPort: null,
        mcpFile: null,
        position: null,
        browser: null,
        headless: updated.headless,
        profileDeleted: false,
        cleanupStarted: false,
        cleanupError: null,
        flow: done
          ? {
              status: 'completed',
              step: null,
              message: 'Đã hoàn tất ở lần chạy trước.',
              startedAt: null,
              finishedAt: null
            }
          : null,
        startedAt: null,
        closedAt: null
      };
    });

    const pending = queue.accounts.some((entry) => entry.status === 'queued');
    queue.active = pending;
    queue.closeOnStop = false;
    queue.concurrency = updated.concurrency;
    queue.headless = updated.headless;
    queue.ephemeral = updated.ephemeral;
    queue.teamUrl = updated.startUrl;
    queue.startedAt = Date.now();
    queue.completedAt = pending ? null : Date.now();

    if (pending) pumpQueue();
    sendJson(response, 200, {
      ok: true,
      queue: publicQueue(),
      config: publicConfig(updated)
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/history/clear') {
    const cleared = clearCompleted();
    sendJson(response, 200, { ok: true, cleared, completedCount: completedCount() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/queue/stop') {
    const body = await readJson(request);
    queue.active = false;
    queue.closeOnStop = Boolean(body.close);
    for (const entry of queue.accounts) {
      if (entry.status === 'queued') {
        finishQueueEntry(entry, 'stopped');
      }
    }
    if (queue.closeOnStop) {
      for (const entry of queue.accounts) {
        if (entry.status === 'running' && isRunning(entry.name)) {
          await closeProfile(entry.name);
          finishQueueEntry(entry, 'closed');
        }
      }
    }
    sendJson(response, 200, { ok: true, queue: publicQueue() });
    return;
  }

  if (request.method === 'POST' && pathname === '/api/queue/complete') {
    const body = await readJson(request);
    const name = String(body.name || '');
    const entry = queue.accounts.find((item) => item.name === name);
    if (!entry) {
      sendJson(response, 404, { ok: false, error: 'Không có tài khoản này trong hàng đợi.' });
      return;
    }
    if (entry.status !== 'running') {
      sendJson(response, 409, { ok: false, error: 'Tài khoản không ở trạng thái đang chạy.' });
      return;
    }

    await closeProfile(entry.name);
    finishQueueEntry(entry, 'closed');
    reconcileQueue();
    sendJson(response, 200, { ok: true, queue: publicQueue() });
    return;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/mcp/')) {
    const name = decodeURIComponent(pathname.slice('/api/mcp/'.length));
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      sendJson(response, 400, { ok: false, error: 'Tên profile không hợp lệ.' });
      return;
    }
    const config = loadConfig();
    const file = path.join(config.mcpDir, `${name}.json`);
    if (!fs.existsSync(file)) {
      sendJson(response, 404, { ok: false, error: 'Chưa có MCP config cho profile này.' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(fs.readFileSync(file));
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Không tìm thấy endpoint.' });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((err) => {
    console.error(`[http] ${err.message}`);
    if (!response.headersSent) sendJson(response, 500, { ok: false, error: err.message });
    else response.end();
  });
});

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Lỗi cấu hình: ${err.message}`);
  process.exit(1);
}

server.once('error', (err) => {
  console.error(`Không mở được UI: ${err.message}`);
  process.exit(1);
});

setInterval(reconcileQueue, 1000);

server.listen(config.uiPort, '127.0.0.1', () => {
  const chrome = getChromeInfo(config);
  const screen = getWorkArea();
  console.log(`UI      : http://127.0.0.1:${config.uiPort}`);
  console.log(`Chrome  : ${chrome.source}${chrome.bundled ? ` ${chrome.bundled.version}` : ''}`);
  console.log(`Path    : ${chrome.path || '(không tìm thấy)'}`);
  console.log(`Màn hình: ${screen.width}x${screen.height}`);
  console.log(`Cửa sổ  : ${config.window.width}x${config.window.height}, scale ${Math.round(config.window.scale * 100)}%`);
  console.log('Giữ terminal này mở khi profile dùng proxy.');
});

async function shutdown() {
  queue.active = false;
  await closeAll();
  if (queue.ephemeral && queue.accounts.length) {
    try {
      const current = loadConfig();
      await Promise.all(
        queue.accounts
          .filter((entry) => !entry.profileDeleted)
          .map((entry) => deleteProfileData(current, entry.name).catch(() => {}))
      );
    } catch {
      // Bỏ qua lỗi dọn dẹp khi thoát.
    }
  }
}

process.on('SIGINT', async () => {
  console.log('\nĐang đóng và dọn profile...');
  await shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
