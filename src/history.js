import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const HISTORY_PATH = path.join(ROOT, 'data', 'completed.json');
const VERSION = 1;

export function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

function loadRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    if (data && typeof data.completed === 'object' && data.completed) return data;
  } catch {
    // Chưa có lịch sử hoặc file hỏng.
  }
  return { version: VERSION, completed: {} };
}

export function loadHistory() {
  return loadRaw();
}

export function isCompleted(email, history = null) {
  const data = history || loadRaw();
  return Boolean(data.completed[hashEmail(email)]);
}

export function markCompleted(email) {
  const data = loadRaw();
  const hash = hashEmail(email);
  if (data.completed[hash]) return false;
  data.completed[hash] = { at: Date.now() };
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  const temporary = `${HISTORY_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, HISTORY_PATH);
  return true;
}

export function completedCount() {
  return Object.keys(loadRaw().completed).length;
}

export function clearCompleted() {
  const count = completedCount();
  try {
    fs.rmSync(HISTORY_PATH, { force: true });
  } catch {
    // Bỏ qua.
  }
  return count;
}
