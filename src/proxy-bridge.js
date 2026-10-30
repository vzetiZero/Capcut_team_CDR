import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

function splitHostPort(value) {
  const raw = String(value || '');
  const index = raw.lastIndexOf(':');
  if (index <= 0) throw new Error(`CONNECT target không hợp lệ: ${raw}`);

  let host = raw.slice(0, index);
  const port = Number(raw.slice(index + 1));
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`CONNECT target không hợp lệ: ${raw}`);
  }
  return { host, port };
}

function proxyAuthorization(upstream) {
  if (!upstream.username) return null;
  const token = Buffer.from(`${upstream.username}:${upstream.password}`).toString('base64');
  return `Basic ${token}`;
}

export function startProxyBridge(upstream) {
  if (upstream.protocol !== 'http' && upstream.protocol !== 'https') {
    throw new Error(`Bridge chỉ hỗ trợ proxy HTTP/HTTPS, nhận: ${upstream.protocol}`);
  }

  const authHeader = proxyAuthorization(upstream);

  const server = http.createServer((req, res) => {
    if (!/^http:\/\//i.test(req.url || '')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Bridge chỉ nhận HTTP absolute-form.');
      return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers.connection;
    if (authHeader) headers['proxy-authorization'] = authHeader;

    const upstreamReq = http.request(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Upstream proxy error');
    });

    req.pipe(upstreamReq);
  });

  server.on('connect', (req, clientSocket, head) => {
    let target;
    try {
      target = splitHostPort(req.url);
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    clientSocket.on('error', () => {});

    const socket =
      upstream.protocol === 'https'
        ? tls.connect({ host: upstream.host, port: upstream.port, servername: upstream.host })
        : net.connect({ host: upstream.host, port: upstream.port });

    let settled = false;
    let buffer = Buffer.alloc(0);

    const fail = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (clientSocket.writable) {
        clientSocket.end(
          `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
        );
      }
    };

    socket.once('error', (err) => {
      if (settled) clientSocket.destroy();
      else fail(`Upstream proxy error: ${err.message}`);
    });
    clientSocket.once('error', () => socket.destroy());

    const sendConnect = () => {
      const lines = [
        `CONNECT ${target.host}:${target.port} HTTP/1.1`,
        `Host: ${target.host}:${target.port}`
      ];
      if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);
      lines.push('Connection: keep-alive', '', '');
      socket.write(lines.join('\r\n'));
    };

    if (upstream.protocol === 'https') socket.once('secureConnect', sendConnect);
    else socket.once('connect', sendConnect);

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail('Upstream response header quá lớn.');
        return;
      }

      const header = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const statusLine = header.split('\r\n')[0] || '';
      const status = Number(statusLine.split(/\s+/)[1]);

      if (status !== 200) {
        fail(`Upstream CONNECT thất bại: ${statusLine}`);
        return;
      }

      settled = true;
      socket.removeAllListeners('data');
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) clientSocket.write(head);
      if (rest.length) clientSocket.write(rest);
      socket.pipe(clientSocket);
      clientSocket.pipe(socket);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}
