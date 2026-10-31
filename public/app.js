const state = {
  config: null,
  queue: null,
  queueSignature: ''
};

let toastTimer = null;

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function toast(message, isError = false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, isError ? 7000 : 3200);
}

function getScreenSize() {
  const detected = state.config?.screen;
  if (detected?.width > 0 && detected?.height > 0) {
    return { width: detected.width, height: detected.height };
  }
  return {
    width: Math.round(window.screen?.availWidth || 1920),
    height: Math.round(window.screen?.availHeight || 1080)
  };
}

function getFormWindow() {
  return {
    width: Number($('winWidth').value) || 600,
    height: Number($('winHeight').value) || 800,
    scale: (Number($('winScale').value) || 80) / 100,
    gap: Number($('winGap').value) || 0,
    columns: Number($('winColumns').value) || 0
  };
}

function renderChrome(config) {
  const badge = $('chrome-badge');
  const status = $('chrome-status');
  const chrome = config.chrome || {};
  const bundled = chrome.bundled;

  badge.className = 'badge';
  if (chrome.source === 'missing') {
    badge.classList.add('bad');
    badge.textContent = 'Chrome: chưa có';
  } else if (chrome.source === 'system') {
    badge.classList.add('warn');
    badge.textContent = 'Chrome hệ thống';
  } else {
    badge.classList.add('ok');
    badge.textContent = bundled ? `Chrome ${bundled.version}` : 'Chrome tuỳ chỉnh';
  }
  badge.title = chrome.path || '';

  const parts = [];
  if (chrome.source === 'bundled' && bundled) {
    parts.push(`Chrome for Testing ${bundled.version} trong vendor/`);
    if (bundled.chromedriverPath) parts.push(`ChromeDriver: ${bundled.chromedriverPath}`);
  } else if (chrome.source === 'system') {
    parts.push(`Dùng Chrome hệ thống: ${chrome.path}`);
    if (bundled) parts.push(`Bundled ${bundled.version} có sẵn nhưng đang tắt.`);
    else parts.push('Chưa có Chrome 142; chạy: npm run setup:chrome142');
  } else if (chrome.source === 'custom') {
    parts.push(`Dùng chromePath tuỳ chỉnh: ${chrome.path}`);
  } else {
    parts.push('Không tìm thấy chrome.exe. Chạy: npm run setup:chrome142');
  }
  status.textContent = parts.join(' · ');
}

function renderConfig() {
  const config = state.config;
  if (!config) return;

  $('useBundledChrome').checked = Boolean(config.useBundledChrome);
  $('chromePath').value = config.chromePath || '';
  $('winWidth').value = config.window.width;
  $('winHeight').value = config.window.height;
  $('winScale').value = Math.round(config.window.scale * 100);
  $('winGap').value = config.window.gap;
  $('winColumns').value = config.window.columns;

  $('teamUrl').value = config.teamUrl || '';
  $('queueConcurrency').value = config.concurrency || 3;
  $('queueHeadless').checked = Boolean(config.headless);
  $('ephemeral').checked = config.ephemeral !== false;
  $('proxyEnabled').checked = Boolean(config.proxyEnabled);
  $('proxiesText').value = config.proxiesText || '';
  updateProxySummary();

  renderChrome(config);
  renderHistory();
  requestAnimationFrame(renderPreview);
}

function renderHistory() {
  const count = state.config?.completedCount || 0;
  const summary = $('history-summary');
  const clear = $('clear-history');
  if (summary) {
    summary.textContent = count
      ? `${count} tài khoản đã hoàn tất — tự bỏ qua khi chạy lại.`
      : 'Chưa có tài khoản nào hoàn tất.';
  }
  if (clear) clear.disabled = count === 0;
}

function proxyLineCount() {
  return $('proxiesText')
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//')).length;
}

function updateProxySummary() {
  const count = proxyLineCount();
  $('proxy-summary').textContent = $('proxyEnabled').checked
    ? `${count} proxy · gán lần lượt cho profile mới`
    : 'Đang tắt · profile dùng IP máy';
}

function renderPreview() {
  const preview = $('layout-preview');
  const summary = $('layout-summary');
  if (!preview || !preview.clientWidth) return;

  const count = Math.max(1, Number($('queueConcurrency').value) || state.config?.concurrency || 3);
  const win = getFormWindow();
  const screen = getScreenSize();

  preview.replaceChildren();

  const gap = Math.max(0, win.gap);
  const columns = win.columns > 0
    ? Math.min(win.columns, count)
    : Math.min(count, Math.max(1, Math.floor((screen.width + gap) / (win.width + gap))));
  const rows = Math.ceil(count / columns);
  const gridWidth = columns * win.width + (columns - 1) * gap;
  const gridHeight = rows * win.height + (rows - 1) * gap;
  const startX = Math.max(0, Math.round((screen.width - gridWidth) / 2));
  const startY = Math.max(0, Math.round((screen.height - gridHeight) / 2));

  const maxHeight = 280;
  const scale = Math.min((preview.clientWidth - 24) / screen.width, (maxHeight - 24) / screen.height);
  const offsetX = Math.max(0, (preview.clientWidth - screen.width * scale) / 2);
  preview.style.height = `${Math.min(maxHeight, screen.height * scale + 24)}px`;

  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = Math.min(startX + column * (win.width + gap), Math.max(0, screen.width - win.width));
    const top = Math.min(startY + row * (win.height + gap), Math.max(0, screen.height - win.height));

    const element = document.createElement('div');
    element.className = 'preview-window';
    element.style.left = `${offsetX + left * scale}px`;
    element.style.top = `${12 + top * scale}px`;
    element.style.width = `${Math.max(12, win.width * scale)}px`;
    element.style.height = `${Math.max(12, win.height * scale)}px`;
    element.textContent = `Cửa sổ ${index + 1}`;
    element.title = `${win.width}x${win.height} tại ${left},${top}`;
    preview.append(element);
  }

  summary.textContent = `${count} cửa sổ · ${columns} cột × ${rows} hàng · màn hình ${screen.width}×${screen.height}`;
}

const QUEUE_LABELS = {
  queued: ['Chờ', ''],
  launching: ['Đang mở', 'warn'],
  running: ['Đang chạy', 'ok'],
  closed: ['Đã đóng', ''],
  error: ['Lỗi', 'bad'],
  stopped: ['Đã dừng', 'warn'],
  completed: ['Đã xong trước', 'ok'],
  retry: ['Chờ chạy lại', 'warn']
};

function queueSignature(queue) {
  if (!queue) return '';
  return JSON.stringify({
    active: queue.active,
    counts: queue.counts,
    accounts: queue.accounts.map((entry) => [
      entry.name,
      entry.status,
      entry.cdpPort,
      entry.proxy,
      entry.profileDeleted,
      entry.cleanupError,
      entry.flow?.status,
      entry.flow?.step,
      entry.flow?.message
    ])
  });
}

function queueStatusNote(entry) {
  if (entry.cleanupError) return { text: entry.cleanupError, error: true };
  if (entry.profileDeleted) return { text: 'Profile đã xoá', error: false };
  return null;
}

function renderQueue() {
  const queue = state.queue;
  const body = $('queue-body');
  if (!body) return;

  if (!queue || queue.accounts.length === 0) {
    body.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = 'Chưa chạy hàng đợi.';
    row.append(cell);
    body.append(row);
    $('queue-summary').textContent = '';
    $('queue-counts').textContent = '';
  } else {
    const counts = queue.counts;
    const skipped = counts.completed ? ` · ${counts.completed} đã xong trước` : '';
    const retry = counts.retry ? ` · ${counts.retry} chờ chạy lại` : '';
    const summary = `${counts.running}/${counts.total} đang mở · ${counts.queued} chờ · ${counts.closed} đóng · ${counts.error} lỗi${retry}${skipped}`;
    $('queue-summary').textContent = summary;
    $('queue-counts').textContent = summary;

    body.replaceChildren();
    for (const entry of queue.accounts) {
      const row = document.createElement('tr');

      const emailCell = document.createElement('td');
      const email = document.createElement('span');
      email.textContent = entry.email;
      emailCell.append(email);
      const name = document.createElement('code');
      name.className = 'profile-name';
      name.textContent = entry.name;
      name.title = 'Thư mục profile tạm';
      emailCell.append(name);
      row.append(emailCell);

      const proxyCell = document.createElement('td');
      proxyCell.textContent = entry.proxy || 'IP máy';
      row.append(proxyCell);

      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      const [label, tone] = QUEUE_LABELS[entry.status] || ['?', ''];
      badge.className = `badge ${tone}`.trim();
      badge.textContent = entry.headless && entry.status === 'running' ? `${label} · ẩn` : label;
      if (entry.error) badge.title = entry.error;
      statusCell.append(badge);
      if (entry.error) {
        const error = document.createElement('p');
        error.className = 'row-error';
        error.textContent = entry.error;
        statusCell.append(error);
      }
      const note = queueStatusNote(entry);
      if (note) {
        const element = document.createElement('p');
        element.className = note.error ? 'row-error' : 'row-note';
        element.textContent = note.text;
        statusCell.append(element);
      }
      if (entry.flow) {
        const flow = document.createElement('p');
        if (entry.flow.status === 'success' || entry.flow.status === 'completed') {
          flow.className = 'row-note ok';
          flow.textContent = entry.flow.message;
        } else if (entry.flow.status === 'error') {
          flow.className = 'row-error';
          flow.textContent = `Đăng nhập: ${entry.flow.message}`;
        } else if (entry.flow.status === 'retry') {
          flow.className = 'row-error';
          flow.textContent = entry.flow.message;
        } else if (entry.flow.status === 'running') {
          flow.className = 'row-note';
          flow.textContent = entry.flow.step || 'Đang đăng nhập...';
        } else if (entry.flow.status === 'skipped') {
          flow.className = 'row-note';
          flow.textContent = entry.flow.message;
        }
        if (flow.className) statusCell.append(flow);
      }
      row.append(statusCell);

      const cdpCell = document.createElement('td');
      cdpCell.textContent = entry.cdpPort ? `:${entry.cdpPort}` : '—';
      row.append(cdpCell);

      const actionCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'row-actions';

      const mcp = document.createElement('button');
      mcp.type = 'button';
      mcp.dataset.action = 'queue-mcp';
      mcp.dataset.name = entry.name;
      mcp.textContent = 'Copy MCP';
      mcp.disabled = entry.status !== 'running' || !entry.cdpPort;

      const done = document.createElement('button');
      done.type = 'button';
      done.className = 'primary';
      done.dataset.action = 'queue-complete';
      done.dataset.name = entry.name;
      done.dataset.email = entry.email;
      done.textContent = 'Xong';
      done.title = 'Đóng Chrome và xoá profile nếu đang bật xoá';
      done.disabled = entry.status !== 'running';

      actions.append(mcp, done);
      actionCell.append(actions);
      row.append(actionCell);

      body.append(row);
    }
  }

  $('queue-start').disabled = Boolean(queue?.active);
  $('queue-stop').disabled = !queue?.active;
  $('queue-close').disabled = (queue?.counts?.running || 0) === 0;
}

async function loadConfig() {
  const data = await api('/api/config');
  state.config = data;
  state.queue = data.queue || null;
  state.queueSignature = queueSignature(state.queue);
  renderConfig();
  renderQueue();
}

async function saveConfig({ silent = false, message = 'Đã lưu cấu hình.' } = {}) {
  const patch = {
    window: getFormWindow(),
    useBundledChrome: $('useBundledChrome').checked,
    chromePath: $('chromePath').value
  };

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data;
  if (data.queue) {
    state.queue = data.queue;
    state.queueSignature = queueSignature(state.queue);
  }

  if (!silent) {
    renderConfig();
    renderQueue();
    toast(message);
  }
  return data;
}

async function saveProxies() {
  $('save-proxies').disabled = true;
  $('proxy-hint').textContent = 'Đang lưu...';
  try {
    const data = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        proxyEnabled: $('proxyEnabled').checked,
        proxiesText: $('proxiesText').value
      })
    });
    state.config = data;
    renderConfig();
    $('proxy-hint').textContent = '';
    toast('Đã lưu danh sách proxy.');
  } catch (err) {
    $('proxy-hint').textContent = '';
    toast(err.message, true);
  } finally {
    $('save-proxies').disabled = false;
  }
}

function setQueueBusy(busy, text = '') {
  $('queue-start').disabled = busy || Boolean(state.queue?.active);
  $('queue-stop').disabled = busy || !state.queue?.active;
  $('queue-close').disabled = busy || (state.queue?.counts?.running || 0) === 0;
  $('queue-hint').textContent = busy ? text : '';
}

async function startQueue() {
  const accountsText = $('accountsText').value;
  if (!accountsText.trim()) {
    toast('Nhập danh sách tài khoản trước.', true);
    return;
  }
  setQueueBusy(true, 'Đang mở các cửa sổ đầu tiên...');
  try {
    const data = await api('/api/queue/start', {
      method: 'POST',
      body: JSON.stringify({
        accountsText,
        teamUrl: $('teamUrl').value,
        concurrency: Number($('queueConcurrency').value) || 3,
        headless: $('queueHeadless').checked,
        ephemeral: $('ephemeral').checked,
        proxyEnabled: $('proxyEnabled').checked,
        proxiesText: $('proxiesText').value
      })
    });
    state.config = data.config;
    state.queue = data.queue;
    state.queueSignature = queueSignature(state.queue);
    renderQueue();
    renderChrome(state.config);
    renderHistory();
    if (data.queue.counts.queued === 0) {
      toast(`Tất cả ${data.queue.counts.completed} tài khoản đã hoàn tất trước đó — không mở profile.`);
    } else {
      const skipped = data.queue.counts.completed ? ` · bỏ qua ${data.queue.counts.completed} đã xong` : '';
      toast(`Đã bắt đầu ${data.queue.counts.queued} tài khoản · ${data.queue.concurrency} luồng${skipped}.`);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    setQueueBusy(false);
    renderQueue();
  }
}

async function stopQueue({ close = false } = {}) {
  if (close && !confirm('Đóng tất cả cửa sổ của hàng đợi và dừng nhận tài khoản mới?')) return;
  setQueueBusy(true, close ? 'Đang đóng cửa sổ...' : 'Đang dừng...');
  try {
    const data = await api('/api/queue/stop', {
      method: 'POST',
      body: JSON.stringify({ close })
    });
    state.queue = data.queue;
    state.queueSignature = queueSignature(state.queue);
    toast(close ? 'Đã đóng cửa sổ hàng đợi.' : 'Đã dừng nhận tài khoản mới.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setQueueBusy(false);
    renderQueue();
  }
}

async function completeQueueAccount(name, email) {
  const label = email || name;
  if (!confirm(`Đánh dấu ${label} đã xong? Chrome sẽ đóng và profile bị xoá (nếu bật xoá).`)) return;
  try {
    const data = await api('/api/queue/complete', {
      method: 'POST',
      body: JSON.stringify({ name })
    });
    state.queue = data.queue;
    state.queueSignature = queueSignature(state.queue);
    renderQueue();
    toast(`Đã kết thúc ${label}.`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearHistory() {
  if (!confirm('Xoá lịch sử tài khoản đã hoàn tất? Các tài khoản này sẽ được chạy lại ở lần sau.')) return;
  try {
    const data = await api('/api/history/clear', { method: 'POST', body: '{}' });
    if (state.config) state.config.completedCount = data.completedCount;
    renderHistory();
    toast(`Đã xoá lịch sử (${data.cleared} tài khoản).`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function copyMcp(name) {
  try {
    const response = await fetch(`/api/mcp/${encodeURIComponent(name)}`);
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // Giữ nguyên.
      }
      throw new Error(message);
    }

    let content = text;
    try {
      content = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Giữ nguyên.
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    } else {
      const area = document.createElement('textarea');
      area.value = content;
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    toast(`Đã copy MCP config của ${name}.`);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.hidden = panel.id !== `tab-${button.dataset.tab}`;
      });
      if (button.dataset.tab === 'config') requestAnimationFrame(renderPreview);
      if (button.dataset.tab === 'accounts') renderQueue();
      if (button.dataset.tab === 'proxy') updateProxySummary();
    });
  });

  $('config-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await saveConfig();
    } catch (err) {
      toast(err.message, true);
    }
  });

  ['winWidth', 'winHeight', 'winScale', 'winGap', 'winColumns', 'queueConcurrency'].forEach((id) => {
    $(id).addEventListener('input', renderPreview);
  });

  ['proxiesText', 'proxyEnabled'].forEach((id) => {
    $(id).addEventListener('input', updateProxySummary);
    $(id).addEventListener('change', updateProxySummary);
  });

  $('save-proxies').addEventListener('click', saveProxies);

  $('queue-start').addEventListener('click', startQueue);
  $('queue-stop').addEventListener('click', () => stopQueue({ close: false }));
  $('queue-close').addEventListener('click', () => stopQueue({ close: true }));
  $('clear-history').addEventListener('click', clearHistory);

  $('queue-body').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const { action, name } = button.dataset;
    if (action === 'queue-mcp') copyMcp(name);
    if (action === 'queue-complete') completeQueueAccount(name, button.dataset.email);
  });

  window.addEventListener('resize', () => requestAnimationFrame(renderPreview));

  setInterval(async () => {
    try {
      const data = await api('/api/status');
      const nextQueueSignature = queueSignature(data.queue);
      if (nextQueueSignature !== state.queueSignature) {
        state.queue = data.queue;
        state.queueSignature = nextQueueSignature;
        renderQueue();
      }

      if (state.config && typeof data.completedCount === 'number' && data.completedCount !== state.config.completedCount) {
        state.config.completedCount = data.completedCount;
        renderHistory();
      }
    } catch {
      // Server có thể đang bận mở profile.
    }
  }, 1500);
}

async function init() {
  bindEvents();
  try {
    await loadConfig();
  } catch (err) {
    toast(`Không tải được cấu hình: ${err.message}`, true);
  }
}

document.addEventListener('DOMContentLoaded', init);
