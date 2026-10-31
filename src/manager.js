import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { connectCdp } from './cdp.js';
import { describeProxy, resolveChromePath } from './config.js';
import { startProxyBridge } from './proxy-bridge.js';

const running = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function pickPort(config, preferred) {
  const used = new Set([...running.values()].map((handle) => handle.cdpPort));
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (!used.has(port) && (await isPortFree(port))) return port;
  }
  throw new Error('Không tìm được cổng CDP trống.');
}

async function waitForCdp(port, hasExited, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExited()) {
      throw new Error('Chrome đã thoát ngay sau khi mở. Profile có thể đang được Chrome khác sử dụng.');
    }
    try {
      const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1000);
      return version;
    } catch {
      // Chrome chưa mở cổng debugging.
    }
    await sleep(300);
  }
  throw new Error(`Chrome không mở cổng CDP ${port} sau ${Math.round(timeoutMs / 1000)} giây.`);
}

async function applyWindowBounds(cdpPort, bounds) {
  if (!bounds || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)) return;

  const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('Không tìm thấy tab để đặt vị trí cửa sổ.');

  const cdp = await connectCdp(cdpPort);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }
    });
  } finally {
    cdp.close();
  }
}

function disablePasswordPrompts(profileDir) {
  const defaultDir = path.join(profileDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const file = path.join(defaultDir, 'Preferences');
  let preferences = {};
  try {
    preferences = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    preferences = {};
  }
  preferences.credentials_enable_service = false;
  preferences.credentials_enable_autosignin = false;
  preferences.profile = {
    ...(preferences.profile || {}),
    password_manager_enabled: false,
    password_manager_leak_detection: false
  };
  fs.writeFileSync(file, JSON.stringify(preferences), 'utf8');
}

function writeMcpConfig(config, name, cdpPort) {
  fs.mkdirSync(config.mcpDir, { recursive: true });
  const mcpConfig = {
    mcpServers: {
      [`chrome-devtools-${name}`]: {
        command: 'npx',
        args: [
          '-y',
          'chrome-devtools-mcp@latest',
          '--browserUrl',
          `http://127.0.0.1:${cdpPort}`,
          '--no-usage-statistics'
        ]
      }
    }
  };
  const file = path.join(config.mcpDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
  return file;
}

function publicHandle(handle, alreadyRunning) {
  return {
    name: handle.name,
    alreadyRunning,
    running: !handle.exited,
    pid: handle.child?.pid || null,
    cdpPort: handle.cdpPort,
    mcpFile: handle.mcpFile,
    chromePath: handle.chromePath,
    browser: handle.browser || null,
    proxy: describeProxy(handle.profile.proxy),
    window: handle.window,
    position: handle.position,
    headless: Boolean(handle.headless),
    startedAt: handle.startedAt
  };
}

export async function launchProfile(config, profile, options = {}) {
  const existing = running.get(profile.name);
  if (existing) {
    if (options.position) {
      try {
        await applyWindowBounds(existing.cdpPort, options.position);
        existing.position = options.position;
      } catch {
        // Cửa sổ vẫn dùng được nếu không đặt lại được vị trí.
      }
    }
    return publicHandle(existing, true);
  }

  const chromePath = options.chromePath || resolveChromePath(config);
  const cdpPort = await pickPort(config, config.basePort);
  const profileDir = path.join(config.profilesDir, profile.name);
  const windowConfig = options.window || config.window;
  const startUrl = options.startUrl || profile.url || config.startUrl;
  const headless = Boolean(options.headless);

  fs.mkdirSync(profileDir, { recursive: true });
  disablePasswordPrompts(profileDir);

  let bridge = null;
  let proxyArgument = null;

  if (profile.proxy) {
    if (profile.proxy.protocol === 'socks5') {
      if (profile.proxy.username) {
        throw new Error(
          'Chrome không hỗ trợ SOCKS5 có user/pass. Dùng proxy HTTP/HTTPS hoặc SOCKS5 không auth.'
        );
      }
      proxyArgument = `socks5://${profile.proxy.host}:${profile.proxy.port}`;
    } else {
      bridge = await startProxyBridge(profile.proxy);
      proxyArgument = bridge.url;
    }
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-save-password-bubble',
    '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection',
    '--disable-search-engine-choice-screen',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${windowConfig.width},${windowConfig.height}`,
    `--force-device-scale-factor=${windowConfig.scale}`,
    ...(headless ? ['--headless=new', '--hide-scrollbars', '--mute-audio'] : []),
    ...(!headless && options.position && Number.isFinite(options.position.left)
      ? [`--window-position=${options.position.left},${options.position.top}`]
      : []),
    ...(proxyArgument ? [`--proxy-server=${proxyArgument}`] : []),
    startUrl
  ];

  const child = spawn(chromePath, args, { stdio: 'ignore' });
  let exited = false;
  let spawnError = null;

  child.once('error', (err) => {
    spawnError = err;
    exited = true;
  });
  child.once('exit', () => {
    exited = true;
  });

  const handle = {
    name: profile.name,
    profile,
    child,
    bridge,
    cdpPort,
    mcpFile: null,
    chromePath,
    browser: null,
    window: windowConfig,
    position: headless ? null : options.position || null,
    headless,
    startedAt: Date.now(),
    exited: false
  };

  try {
    let version;
    try {
      version = await waitForCdp(cdpPort, () => exited);
    } catch (err) {
      if (spawnError) throw new Error(`Không chạy được Chrome: ${spawnError.message}`);
      throw err;
    }

    await sleep(300);
    if (!headless && options.position) {
      try {
        await applyWindowBounds(cdpPort, options.position);
      } catch (err) {
        console.warn(`[window] Không đặt được vị trí/kích thước qua CDP: ${err.message}`);
      }
    }

    handle.mcpFile = writeMcpConfig(config, profile.name, cdpPort);
    handle.browser = version.Browser || null;
    running.set(profile.name, handle);

    child.once('exit', async () => {
      handle.exited = true;
      if (handle.bridge) {
        try {
          await handle.bridge.close();
        } catch {
          // Bỏ qua.
        }
      }
      running.delete(profile.name);
    });

    return publicHandle(handle, false);
  } catch (err) {
    if (bridge) await bridge.close();
    if (!exited) {
      try {
        child.kill();
      } catch {
        // Bỏ qua.
      }
    }
    throw err;
  }
}

export async function deleteProfileData(config, name) {
  const profileDir = path.join(config.profilesDir, name);
  const mcpFile = path.join(config.mcpDir, `${name}.json`);
  await fs.promises.rm(mcpFile, { force: true });

  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.promises.rm(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      return true;
    } catch (err) {
      lastError = err;
      await sleep(400);
    }
  }
  throw new Error(`Không xoá được profile ${name}: ${lastError?.message || 'lỗi không xác định'}`);
}

export async function closeProfile(name) {
  const handle = running.get(name);
  if (!handle) return { ok: false, error: `Profile "${name}" không chạy.` };

  const pid = handle.child?.pid;
  if (pid && process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', resolve);
      setTimeout(resolve, 4000);
    });
  } else if (pid) {
    try {
      process.kill(pid);
    } catch {
      // Bỏ qua.
    }
  }

  for (let attempt = 0; attempt < 30 && running.has(name); attempt += 1) {
    await sleep(100);
  }

  if (running.has(name)) {
    if (handle.bridge) await handle.bridge.close().catch(() => {});
    running.delete(name);
  }

  return { ok: true, name };
}

export async function closeAll() {
  const names = [...running.keys()];
  for (const name of names) {
    await closeProfile(name);
  }
  return names;
}

export function getRunning() {
  return [...running.values()].map((handle) => publicHandle(handle, false));
}

export function isRunning(name) {
  return running.has(name);
}
