import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT, 'profiles.json');
const BUNDLED_MANIFEST = path.join(ROOT, 'vendor', 'chrome-142.json');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null
].filter(Boolean);

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeConcurrency(value) {
  return Math.round(clampNumber(value, 3, 1, 20));
}

export function normalizeTeamUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Link team không được để trống.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Link team không hợp lệ: "${text}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Link team phải bắt đầu bằng http:// hoặc https://');
  }
  return url.toString();
}

function normalizeWindow(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  let scale = clampNumber(input.scale, 0.8, 0.5, 2);
  if (scale > 2) scale /= 100;

  return {
    width: Math.round(clampNumber(input.width, 600, 320, 3840)),
    height: Math.round(clampNumber(input.height, 800, 240, 2160)),
    scale: Math.round(scale * 100) / 100,
    gap: Math.round(clampNumber(input.gap, 12, 0, 200)),
    columns: Math.round(clampNumber(input.columns, 0, 0, 12))
  };
}

export function parseProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    url = new URL(value);
  } else {
    const parts = value.split(':');
    if (parts.length === 2) {
      url = new URL(`http://${parts[0]}:${parts[1]}`);
    } else if (parts.length === 4) {
      url = new URL(`http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`);
    } else {
      throw new Error(`Proxy không hợp lệ: "${value}" (dùng http://user:pass@host:port hoặc host:port:user:pass)`);
    }
  }

  let protocol = url.protocol.replace(':', '').toLowerCase();
  if (protocol === 'socks5h') protocol = 'socks5';
  if (!['http', 'https', 'socks5'].includes(protocol)) {
    throw new Error(`Proxy protocol không hỗ trợ: ${protocol}`);
  }

  const port = Number(url.port) || (protocol === 'https' ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || !port) throw new Error(`Proxy thiếu host/port: "${value}"`);

  return {
    protocol,
    host,
    port,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || '')
  };
}

export function describeProxy(proxy) {
  if (!proxy) return 'IP máy';
  const auth = proxy.username ? ' (auth)' : '';
  return `${proxy.protocol}://${proxy.host}:${proxy.port}${auth}`;
}

export function readBundledChrome() {
  try {
    const manifest = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST, 'utf8'));
    const chromePath = path.resolve(ROOT, manifest.chromePath);
    const chromedriverPath = manifest.chromedriverPath
      ? path.resolve(ROOT, manifest.chromedriverPath)
      : null;
    if (!fs.existsSync(chromePath)) return null;
    return {
      version: manifest.version,
      chromePath,
      chromedriverPath: chromedriverPath && fs.existsSync(chromedriverPath) ? chromedriverPath : null,
      downloadedAt: manifest.downloadedAt || null
    };
  } catch {
    return null;
  }
}

export function resolveChromePath(input) {
  const config = typeof input === 'string' ? { chromePath: input } : input || {};

  if (config.chromePath) {
    if (fs.existsSync(config.chromePath)) return config.chromePath;
    throw new Error(`chromePath không tồn tại: ${config.chromePath}`);
  }

  if (config.useBundledChrome !== false) {
    const bundled = readBundledChrome();
    if (bundled) return bundled.chromePath;
  }

  const found = CHROME_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (found) return found;

  throw new Error(
    'Không tìm thấy chrome.exe. Chạy "npm run setup:chrome142" hoặc đặt "chromePath" trong profiles.json.'
  );
}

export function getChromeInfo(config) {
  const bundled = readBundledChrome();
  let resolved = null;
  let source = null;

  try {
    resolved = resolveChromePath(config);
    if (config.chromePath) source = 'custom';
    else if (bundled && resolved === bundled.chromePath) source = 'bundled';
    else source = 'system';
  } catch {
    source = 'missing';
  }

  return {
    source,
    path: resolved,
    bundled: bundled
      ? {
          version: bundled.version,
          chromePath: bundled.chromePath,
          chromedriverPath: bundled.chromedriverPath,
          downloadedAt: bundled.downloadedAt
        }
      : null
  };
}

export function loadConfig() {
  let text = null;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Không đọc được ${CONFIG_PATH}: ${err.message}`);
  }

  let raw = {};
  if (text !== null) {
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(`profiles.json không phải JSON hợp lệ: ${err.message}`);
    }
  }

  const proxies = Array.isArray(raw.proxies) ? raw.proxies.map((line) => String(line).trim()).filter(Boolean) : [];

  return {
    root: ROOT,
    chromePath: String(raw.chromePath || '').trim(),
    useBundledChrome: raw.useBundledChrome !== false,
    profilesDir: path.resolve(ROOT, raw.profilesDir || 'profiles'),
    mcpDir: path.resolve(ROOT, raw.mcpDir || 'mcp'),
    basePort: Number(raw.basePort) || 9300,
    uiPort: Number(raw.uiPort) || 8788,
    startUrl: String(raw.teamUrl || raw.startUrl || 'about:blank').trim(),
    concurrency: normalizeConcurrency(raw.concurrency),
    headless: Boolean(raw.headless),
    ephemeral: raw.ephemeral !== false,
    proxyEnabled: Boolean(raw.proxyEnabled),
    proxies,
    proxiesText: proxies.join('\n'),
    window: normalizeWindow(raw.window)
  };
}

export function saveConfig(patch = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Không đọc được profiles.json: ${err.message}`);
    }
  }

  if (patch.window) raw.window = normalizeWindow({ ...raw.window, ...patch.window });
  if (typeof patch.useBundledChrome === 'boolean') raw.useBundledChrome = patch.useBundledChrome;
  if (typeof patch.chromePath === 'string') raw.chromePath = patch.chromePath.trim();
  if (patch.uiPort !== undefined) raw.uiPort = Number(patch.uiPort) || raw.uiPort || 8788;
  if (patch.teamUrl !== undefined) {
    raw.teamUrl = normalizeTeamUrl(patch.teamUrl);
    delete raw.startUrl;
  }
  if (patch.concurrency !== undefined) raw.concurrency = normalizeConcurrency(patch.concurrency);
  if (typeof patch.headless === 'boolean') raw.headless = patch.headless;
  if (typeof patch.ephemeral === 'boolean') raw.ephemeral = patch.ephemeral;
  if (typeof patch.proxyEnabled === 'boolean') raw.proxyEnabled = patch.proxyEnabled;

  if (patch.proxiesText !== undefined) {
    const lines = String(patch.proxiesText).replace(/\r\n?/g, '\n').split('\n');
    const kept = [];
    lines.forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;
      try {
        parseProxy(line);
      } catch (err) {
        throw new Error(`Proxy dòng ${index + 1}: ${err.message}`);
      }
      kept.push(line);
    });
    raw.proxies = kept;
  }

  const temporary = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, CONFIG_PATH);
  return loadConfig();
}
