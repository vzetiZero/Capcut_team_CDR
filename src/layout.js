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

export function computeLayout(count, screen, windowConfig) {
  if (count <= 0) return [];

  const width = windowConfig.width;
  const height = windowConfig.height;
  const gap = windowConfig.gap;
  const columns =
    windowConfig.columns > 0
      ? Math.min(windowConfig.columns, count)
      : Math.min(count, Math.max(1, Math.floor((screen.width + gap) / (width + gap))));
  const rows = Math.ceil(count / columns);
  const gridWidth = columns * width + (columns - 1) * gap;
  const gridHeight = rows * height + (rows - 1) * gap;
  const startX = Math.max(0, Math.round((screen.width - gridWidth) / 2));
  const startY = Math.max(0, Math.round((screen.height - gridHeight) / 2));

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = Math.min(startX + column * (width + gap), Math.max(0, screen.width - width));
    const top = Math.min(startY + row * (height + gap), Math.max(0, screen.height - height));
    return { left, top, width, height, column, row };
  });
}
