import { execFileSync } from 'node:child_process';

let cachedWorkArea = null;

export function getWorkArea() {
  if (cachedWorkArea) return cachedWorkArea;

  if (process.platform === 'win32') {
    try {
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$area=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
        'Write-Output "$($area.Width)x$($area.Height)"';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      }).trim();
      const [width, height] = output.split('x').map(Number);
      if (width > 0 && height > 0) {
        cachedWorkArea = { width, height };
        return cachedWorkArea;
      }
    } catch {
      // Fallback bên dưới.
    }
  }

  cachedWorkArea = { width: 1920, height: 1080 };
  return cachedWorkArea;
}

// getWorkArea trả về pixel vật lý; Chrome/CDP đặt cửa sổ theo DIP (CSS px).
// Với --force-device-scale-factor=0.8, 1 DIP = 0.8 pixel vật lý.
// Chrome không cho thu cửa sổ dưới ~520 DIP chiều rộng, nên phải tôn trọng mức tối thiểu
// thay vì thu nhỏ tuỳ ý (thu nhỏ quá sẽ bị Chrome nong ra và đè lên nhau).
const MIN_WINDOW_WIDTH = 520;
const MIN_WINDOW_HEIGHT = 200;

export function computeLayout(count, screen, windowConfig) {
  if (count <= 0) return [];

  const gap = Math.max(0, windowConfig.gap || 0);
  const scale = windowConfig.scale > 0 ? windowConfig.scale : 1;
  const availableWidth = Math.floor(screen.width / scale);
  const availableHeight = Math.floor(screen.height / scale);

  let best = null;
  for (let columns = 1; columns <= count; columns += 1) {
    if (windowConfig.columns > 0 && windowConfig.columns !== columns) continue;
    const rows = Math.ceil(count / columns);
    const cellWidth = (availableWidth - (columns - 1) * gap) / columns;
    const cellHeight = (availableHeight - (rows - 1) * gap) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;

    const width = Math.max(MIN_WINDOW_WIDTH, Math.min(windowConfig.width, Math.floor(cellWidth)));
    const height = Math.max(MIN_WINDOW_HEIGHT, Math.min(windowConfig.height, Math.floor(cellHeight)));
    if (columns * width + (columns - 1) * gap > availableWidth) continue;
    if (rows * height + (rows - 1) * gap > availableHeight) continue;

    const area = width * height;
    const aspect = Math.abs(width / height - windowConfig.width / windowConfig.height);
    if (
      !best
      || area > best.area
      || (area === best.area && aspect < best.aspect)
    ) {
      best = { columns, rows, width, height, area, aspect };
    }
  }

  if (!best) {
    const columns = windowConfig.columns > 0 ? Math.min(windowConfig.columns, count) : Math.ceil(Math.sqrt(count));
    best = {
      columns,
      rows: Math.ceil(count / columns),
      width: Math.max(MIN_WINDOW_WIDTH, windowConfig.width),
      height: Math.max(MIN_WINDOW_HEIGHT, windowConfig.height)
    };
  }

  const gridWidth = best.columns * best.width + (best.columns - 1) * gap;
  const gridHeight = best.rows * best.height + (best.rows - 1) * gap;
  const startX = Math.max(0, Math.round((availableWidth - gridWidth) / 2));
  const startY = Math.max(0, Math.round((availableHeight - gridHeight) / 2));

  return Array.from({ length: count }, (_, index) => {
    const column = index % best.columns;
    const row = Math.floor(index / best.columns);
    return {
      left: startX + column * (best.width + gap),
      top: startY + row * (best.height + gap),
      width: best.width,
      height: best.height,
      column,
      row
    };
  });
}
