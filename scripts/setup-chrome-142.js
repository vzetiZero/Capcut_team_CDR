import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const DOWNLOADS = path.join(VENDOR, 'downloads');
const MANIFEST = path.join(VENDOR, 'chrome-142.json');
const VERSIONS_URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';

const force = process.argv.includes('--force');

function findDownload(entry, name, platform) {
  return entry.downloads?.[name]?.find((item) => item.platform === platform);
}

async function pickVersion() {
  const response = await fetch(VERSIONS_URL);
  if (!response.ok) throw new Error(`Không tải được danh sách Chrome for Testing (HTTP ${response.status}).`);
  const data = await response.json();
  const candidates = data.versions
    .filter(
      (entry) =>
        entry.version.startsWith('142.') &&
        findDownload(entry, 'chrome', 'win64') &&
        findDownload(entry, 'chromedriver', 'win64')
    )
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));

  if (candidates.length === 0) throw new Error('Không tìm thấy bản Chrome for Testing 142 cho win64.');
  return candidates.at(-1);
}

async function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    console.log(`  Đã có: ${path.relative(ROOT, destination)}`);
    return;
  }

  console.log(`  Tải: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} khi tải ${url}`);

  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  let lastPercent = 0;

  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    const percent = total ? Math.floor((received / total) * 100) : 0;
    if (percent >= lastPercent + 10) {
      lastPercent = percent;
      console.log(`    ${percent}% (${(received / 1024 / 1024).toFixed(1)} MB)`);
    }
  });

  await pipeline(source, fs.createWriteStream(destination));
  console.log(`    Xong: ${(received / 1024 / 1024).toFixed(1)} MB`);
}

function extract(zipPath, destination) {
  if (process.platform !== 'win32') {
    throw new Error('Script giải nén hiện chỉ hỗ trợ Windows (PowerShell Expand-Archive).');
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  console.log(`  Giải nén: ${path.relative(ROOT, zipPath)}`);
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(destination)} -Force`
    ],
    { stdio: 'inherit' }
  );
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Chrome for Testing 142 trong dự án này dành cho Windows.');
  }

  if (fs.existsSync(MANIFEST) && !force) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const chromePath = path.resolve(ROOT, manifest.chromePath);
    const driverPath = path.resolve(ROOT, manifest.chromedriverPath);
    if (fs.existsSync(chromePath) && fs.existsSync(driverPath)) {
      console.log(`Đã có Chrome ${manifest.version} + ChromeDriver trong vendor/.`);
      console.log(`  Chrome : ${path.relative(ROOT, chromePath)}`);
      console.log(`  Driver : ${path.relative(ROOT, driverPath)}`);
      console.log('Dùng --force để tải lại.');
      return;
    }
  }

  console.log('Đang tìm bản Chrome for Testing 142 mới nhất...');
  const entry = await pickVersion();
  const chromeUrl = findDownload(entry, 'chrome', 'win64').url;
  const driverUrl = findDownload(entry, 'chromedriver', 'win64').url;
  console.log(`Phiên bản: ${entry.version}`);

  const chromeZip = path.join(DOWNLOADS, `chrome-${entry.version}-win64.zip`);
  const driverZip = path.join(DOWNLOADS, `chromedriver-${entry.version}-win64.zip`);

  console.log('Tải Chrome:');
  await download(chromeUrl, chromeZip);
  console.log('Tải ChromeDriver:');
  await download(driverUrl, driverZip);

  const chromeDir = path.join(VENDOR, 'chrome-142');
  const driverDir = path.join(VENDOR, 'chromedriver-142');
  extract(chromeZip, chromeDir);
  extract(driverZip, driverDir);

  const chromePath = path.join(chromeDir, 'chrome-win64', 'chrome.exe');
  const driverPath = path.join(driverDir, 'chromedriver-win64', 'chromedriver.exe');
  if (!fs.existsSync(chromePath)) throw new Error(`Không thấy chrome.exe sau giải nén: ${chromePath}`);
  if (!fs.existsSync(driverPath)) throw new Error(`Không thấy chromedriver.exe sau giải nén: ${driverPath}`);

  const manifest = {
    version: entry.version,
    chromePath: path.relative(ROOT, chromePath).split(path.sep).join('/'),
    chromedriverPath: path.relative(ROOT, driverPath).split(path.sep).join('/'),
    downloadedAt: new Date().toISOString()
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`Hoàn tất Chrome ${entry.version}.`);
  console.log(`  Chrome   : ${manifest.chromePath}`);
  console.log(`  Driver   : ${manifest.chromedriverPath}`);
  console.log('ChromeDriver chỉ cần cho Selenium; chrome-devtools-mcp dùng CDP trực tiếp.');
}

main().catch((err) => {
  console.error(`\nLỗi: ${err.message}`);
  process.exitCode = 1;
});
