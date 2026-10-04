// 一次性数据迁移：uuid 型协议（VLESS/XTLS-Reality/H2-Reality/gRPC-Reality/TUIC/VLESS-Argo）
// 的授权凭据若不是合法 UUID（历史 bug：TUIC 曾被误归为 password 型，存了 base64 密码），
// 一律重生成。password 型协议（Hysteria2/Trojan/AnyTLS）不动。
//
// 幂等：已是合法 UUID 的行不会被触碰，所以重复执行安全。
// 用法：node tools/migrate_uuid_credentials.mjs '<执行SQL的回调>'
import { randomUUID } from 'node:crypto';

export const UUID_PROTOCOLS = ['VLESS', 'XTLS-Reality', 'Reality', 'H2-Reality', 'gRPC-Reality', 'VLESS-Argo', 'TUIC'];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function needsFix(protocol, credential) {
  return UUID_PROTOCOLS.includes(protocol) && !UUID_RE.test(String(credential || '').trim());
}

export function newCredential() {
  return randomUUID();
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('module loaded:', UUID_PROTOCOLS.length, 'protocols');
}
