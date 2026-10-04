// 生成测试环境管理员凭据：按项目内 passwordHash 的同款算法（PBKDF2-SHA256/100k）
// 用法：node tools/make_admin.mjs <username> <password>
// 输出可直接喂给 wrangler d1 execute 的 INSERT 语句。
import { webcrypto as crypto } from 'node:crypto';

const base64Bytes = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

async function passwordHash(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return `pbkdf2$${iterations}$${base64Bytes(salt)}$${base64Bytes(new Uint8Array(bits))}`;
}

function sessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const username = process.argv[2] || 'kui';
const password = process.argv[3] || '';
if (password.length < 12) { console.error('密码至少 12 位'); process.exit(1); }

const hash = await passwordHash(password);
const hmacKey = sessionToken();
const esc = (s) => String(s).replace(/'/g, "''");

console.log(`DELETE FROM admin_credentials;`);
console.log(`INSERT INTO admin_credentials (id, username, password, hmac_key, updated_at) VALUES (1, '${esc(username)}', '${esc(hash)}', '${esc(hmacKey)}', ${Date.now()});`);
console.error(`username=${username}`);
console.error(`password=${password}`);