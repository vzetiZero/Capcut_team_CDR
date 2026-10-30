const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
}

export async function connectCdp(port, webSocketUrl = null) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Node.js hiện tại không có WebSocket; cần Node 22+ để điều khiển Chrome qua CDP.');
  }

  const url = webSocketUrl || (await fetchJson(`http://127.0.0.1:${port}/json/version`)).webSocketDebuggerUrl;
  const socket = new WebSocket(url);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout kết nối CDP WebSocket.')), 5000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Không kết nối được CDP WebSocket.'));
      },
      { once: true }
    );
  });

  let nextId = 1;
  const pending = new Map();

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
    else entry.resolve(message.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send,
    close: () => {
      try {
        socket.close();
      } catch {
        // Bỏ qua.
      }
    }
  };
}

export async function createPageSession(port) {
  let targets = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      if (targets.some((target) => target.type === 'page')) break;
    } catch {
      // Chrome chưa sẵn sàng.
    }
    await sleep(300);
  }

  const page = targets?.find((target) => target.type === 'page');
  if (!page) throw new Error('Không tìm thấy tab để thao tác qua CDP.');

  const cdp = await connectCdp(port, page.webSocketDebuggerUrl);
  return {
    async evaluate(expression) {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        const description = result.exceptionDetails.exception?.description
          || result.exceptionDetails.text
          || 'Lỗi JavaScript trên trang.';
        throw new Error(description);
      }
      return result.result?.value;
    },
    close: () => cdp.close()
  };
}
