import crypto from 'node:crypto';

const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;

export function parseAccounts(text) {
  const accounts = [];
  const errors = [];
  const seen = new Set();

  String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((raw, index) => {
      const lineNumber = index + 1;
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;

      const separator = line.search(/[|\t]/);
      const email = (separator === -1 ? line : line.slice(0, separator)).trim();
      const password = separator === -1 ? '' : line.slice(separator + 1).trim();

      if (!EMAIL_PATTERN.test(email)) {
        errors.push({ line: lineNumber, message: `Email không hợp lệ: "${email || line}"` });
        return;
      }
      const key = email.toLowerCase();
      if (seen.has(key)) {
        errors.push({ line: lineNumber, message: `Trùng tài khoản: ${email}` });
        return;
      }
      seen.add(key);
      accounts.push({ email, password });
    });

  return { accounts, errors };
}

export function accountProfileName(email) {
  const [localPart, domainPart] = String(email).toLowerCase().split('@');
  const local = (localPart || '').replace(/[^a-z0-9]/g, '').slice(0, 14) || 'user';
  const domain = (domainPart || '').split('.')[0].replace(/[^a-z0-9]/g, '').slice(0, 10);
  const hash = crypto.createHash('sha1').update(String(email).toLowerCase()).digest('hex').slice(0, 6);
  return `acct-${local}${domain ? `-${domain}` : ''}-${hash}`;
}
