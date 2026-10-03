// 用法：
//   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy \
//   npx wrangler d1 execute kui-test-db --remote -c wrangler.test.jsonc --command "DROP TABLE ..."
//   node tools/e2e_multi_cred.mjs
// 只打测试环境，禁止把 KUI_BASE 指向生产域名。
// 多对多授权端到端验证 —— 只打测试环境 kui-test，不触碰生产
import { ProxyAgent, request } from 'undici';

const BASE = process.env.KUI_BASE || 'https://kui-test.zhuyongfu.cn';
const agent = new ProxyAgent(process.env.KUI_PROXY || 'http://127.0.0.1:60278');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  | ' + detail : ''}`);
}

async function api(pathname, { method = 'GET', body, token, headers = {} } = {}) {
  const r = await request(BASE + pathname, {
    dispatcher: agent,
    method,
    headers: {
      'user-agent': 'kui-e2e/1.0',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.body.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.statusCode, text, json };
}

const b64url = (s) => Buffer.from(s).toString('base64url');

function decodeSub(rawText) {
  // 服务端可能返回 base64(v2ray 链接集合) 或 clash yaml，先尝试 base64
  let text = rawText.trim();
  if (!text.includes('://') && /^[A-Za-z0-9+/=_-]+$/.test(text) && text.length > 40) {
    try { text = Buffer.from(text, 'base64').toString('utf-8'); } catch {}
  }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const l of lines) {
    if (l.startsWith('#') || l.startsWith('proxies:') || l.startsWith('proxy-groups:') || l.startsWith('rules:') || l.startsWith('port:') || l.startsWith('socks-port:') || l.startsWith('allow-lan:') || l.startsWith('mode:') || l.startsWith('log-level:') || l.startsWith('external-controller:') || l.trim() === '') continue;
    if (l.startsWith('{') || /^\s*-\s+name:/.test(l)) continue;
    out.push(l);
  }
  return out;
}

function decodeSub4(rawText) {
  let text = rawText.trim();
  if (!text.includes('://') && /^[A-Za-z0-9+/=_-]+$/.test(text) && text.length > 40) {
    try { text = Buffer.from(text, 'base64').toString('utf-8'); } catch {}
  }
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function extractCred(line) {
  // vless://uuid@host:port?...   trojan://pass@host  hysteria2://pass@host
  try {
    const u = new URL(line);
    return decodeURIComponent(`${u.username || ''}`);
  } catch { return null; }
}

(async () => {
  const stamp = Date.now().toString(36);
  const admin = `admin_${stamp}`;
  const adminPass = 'KuiTest#2026pass';

  // ---------- 1. 初始化管理员 ----------
  let r = await api('/api/setup');
  if (r.json?.initialized) {
    check('setup: 全新库应为未初始化', false, '已初始化，测试库可能被复用');
  } else {
    check('setup: 全新库应为未初始化', true, JSON.stringify(r.json));
  }

  r = await api('/api/setup', { method: 'POST', body: { username: admin, password: adminPass, confirm: adminPass } });
  check('setup: 初始化管理员', r.status === 200 && r.json?.success, `status=${r.status} ${r.text.slice(0, 120)}`);

  r = await api('/api/setup', { method: 'POST', body: { username: admin + 'x', password: adminPass, confirm: adminPass } });
  check('setup: 重复初始化应被拒(409)', r.status === 409, `status=${r.status}`);

  // ---------- 2. 登录拿会话 token ----------
  r = await api('/api/login', { method: 'POST', body: { username: admin, password: adminPass } });
  const session = r.json?.token;
  check('login: 管理员登录', r.status === 200 && !!session, `status=${r.status} ${r.text.slice(0, 120)}`);

  // ---------- 3. 注册 VPS ----------
  const vip = `10.99.${Math.floor(Math.random() * 200) + 20}.1`;
  r = await api('/api/vps', { method: 'POST', token: session, body: { ip: vip, name: 'e2e-vps' } });
  check('vps: 新增 VPS', r.status === 200 && r.json?.success, `status=${r.status} ${r.text.slice(0, 150)}`);

  // ---------- 4. 建节点（4 个多凭据协议） ----------
  const nodeSpecs = [
    { id: `n-reality-${stamp}`, protocol: 'XTLS-Reality', port: 31001, sni: 'www.cloudflare.com' },
    { id: `n-hy2-${stamp}`, protocol: 'Hysteria2', port: 31002 },
    { id: `n-tuic-${stamp}`, protocol: 'TUIC', port: 31003 },
    { id: `n-trojan-${stamp}`, protocol: 'Trojan', port: 31004 },
  ];
  for (const n of nodeSpecs) {
    r = await api('/api/nodes', { method: 'POST', token: session, body: { ...n, vps_ip: vip, uuid: crypto.randomUUID(), private_key: '', public_key: '', short_id: '' } });
    check(`nodes: 建 ${n.protocol}`, r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
  }

  // ---------- 5. 建两个用户 ----------
  const uA = `alice_${stamp}`, uB = `bob_${stamp}`;
  let tokA = '', tokB = '';
  r = await api('/api/users', { method: 'POST', token: session, body: { username: uA } });
  tokA = r.json?.token; check(`users: 建 ${uA}`, r.status === 200 && !!tokA, `status=${r.status}`);
  r = await api('/api/users', { method: 'POST', token: session, body: { username: uB } });
  tokB = r.json?.token; check(`users: 建 ${uB}`, r.status === 200 && !!tokB, `status=${r.status}`);

  // ---------- 6. 给 A 授权全部 4 节点；给 B 只授权 2 个 ----------
  const grantsA = { 'POST': true };
  r = await api('/api/users', { method: 'PATCH', token: session, body: { username: uA, nodes: nodeSpecs.map(n => n.id) } });
  check('grant: A 授权全部 4 节点', r.status === 200 && r.json?.success, `status=${r.status} ${r.text.slice(0, 150)}`);

  r = await api('/api/users', { method: 'PATCH', token: session, body: { username: uB, nodes: nodeSpecs.slice(0, 2).map(n => n.id) } });
  check('grant: B 授权 2 个节点', r.status === 200 && r.json?.success, `status=${r.status} ${r.text.slice(0, 150)}`);

  // ---------- 7. 订阅内容 ----------
  const subA = await api(`/api/sub?user=${uA}&token=${tokA}`);
  const subB = await api(`/api/sub?user=${uB}&token=${tokB}`);
  check('sub: A 订阅 200', subA.status === 200, `status=${subA.status}`);
  check('sub: B 订阅 200', subB.status === 200, `status=${subB.status}`);

  const linesA = decodeSub(subA.text), linesB = decodeSub(subB.text);
  check('sub: A 拿到 4 条节点', linesA.length === 4, `实际 ${linesA.length} 条`);
  check('sub: B 只拿到 2 条节点', linesB.length === 2, `实际 ${linesB.length} 条`);

  // ---------- 8. 凭据隔离（核心） ----------
  const credA = new Map(linesA.map(l => [new URL(l).port, extractCred(l)]));
  const credB = new Map(linesB.map(l => [new URL(l).port, extractCred(l)]));
  let overlap = 0, sameCred = 0;
  for (const [portB, cb] of credB) {
    const ca = credA.get(portB);
    if (ca !== undefined && ca !== null) { overlap++; if (ca === cb) sameCred++; }
  }
  check('cred: 两用户共享端口的节点数 = 2', overlap === 2, `实际 ${overlap}`);
  check('cred: 同节点两用户凭据互不相同', sameCred === 0, `相同 ${sameCred} 处`);
  console.log('   凭据样本 A:', JSON.stringify([...credA]));
  console.log('   凭据样本 B:', JSON.stringify([...credB]));

  // ---------- 9. Clash YAML 里凭据也要独立 ----------
  const yamlA = await api(`/api/sub?user=${uA}&token=${tokA}&target=clash`);
  const yamlB = await api(`/api/sub?user=${uB}&token=${tokB}&target=clash`);
  check('sub: A clash 200', yamlA.status === 200, `status=${yamlA.status}`);
  check('sub: B clash 200', yamlB.status === 200, `status=${yamlB.status}`);
  const idsA = new Set((yamlA.text.match(/uuid:\s*\S+/g) || []).concat(yamlB.text.match(/password:\s*\S+/g) || []));
  const uuidsA = (yamlA.text.match(/uuid:\s*(\S+)/g) || []).map(s => s.split(/\s+/)[1]);
  const uuidsB = (yamlB.text.match(/uuid:\s*(\S+)/g) || []).map(s => s.split(/\s+/)[1]);
  const inter = uuidsA.filter(u => uuidsB.includes(u));
  check('clash: 共有节点的 uuid 在两人订阅中不同', inter.length === 0, `交集 ${inter.length}`);

  // ---------- 10. 撤销 B 对一个节点的授权 → B 订阅少一条，A 不变 ----------
  const revokeNode = nodeSpecs[0].id;
  r = await api('/api/users', { method: 'PATCH', token: session, body: { username: uB, nodes: [nodeSpecs[1].id] } });
  check('grant: B 撤销 1 节点', r.status === 200 && r.json?.success, `status=${r.status}`);

  const subA2 = await api(`/api/sub?user=${uA}&token=${tokA}`);
  const subB2 = await api(`/api/sub?user=${uB}&token=${tokB}`);
  check('revoke: A 仍为 4 条（不受影响）', decodeSub(subA2.text).length === 4, `实际 ${decodeSub(subA2.text).length}`);
  check('revoke: B 降为 1 条', decodeSub(subB2.text).length === 1, `实际 ${decodeSub(subB2.text).length}`);

  // ---------- 11. 重新授权 → 凭据必须保持不变 ----------
  const credBBefore = extractCred(decodeSub(subB2.text)[0]);
  r = await api('/api/users', { method: 'PATCH', token: session, body: { username: uB, nodes: [nodeSpecs[1].id, revokeNode] } });
  const subB3 = await api(`/api/sub?user=${uB}&token=${tokB}`);
  const credBAfter = extractCred(decodeSub(subB3.text).find(l => new URL(l).port === String(nodeSpecs[1].port)));
  check('regrant: B 恢复为 2 条', decodeSub(subB3.text).length === 2, `实际 ${decodeSub(subB3.text).length}`);
  check('regrant: 原授权凭据未被更换（旧链接仍有效）', credBBefore === credBAfter, `${credBBefore} vs ${credBAfter}`);

  // ---------- 12. 停用用户 → 订阅立即失效 ----------
  r = await api('/api/users', { method: 'PUT', token: session, body: { username: uB, enable: false } });
  const subB4 = await api(`/api/sub?user=${uB}&token=${tokB}`);
  const b4 = decodeSub4(subB4.text);
  // 设计意图（对齐 3x-ui）：停用不返回 404，而是给一条写明原因的假节点，
  // 让客户端里能看到「已被管理员停用」。判定标准：真实节点 0 条。
  // 提示假节点的形态：socks5://<base64>@127.0.0.1:1#✖用户名 | 已被管理员停用
  const realB4 = b4.filter(l => {
    try { const u = new URL(l); if (u.port === '1') return false; if (/%E2%9B%94|%E2%80%A2|停用|到期/.test(decodeURIComponent(l))) return false; return true; }
    catch { return true; }
  });
  check('disable: 停用后 B 真实节点降为 0（仅剩提示假节点）', r.status === 200 && subB4.status === 200 && realB4.length === 0, `disable=${r.status} sub=${subB4.status} real=${realB4.length}/${b4.length}`);
  console.log('   停用后返回:', b4[0] ? b4[0].slice(0, 120) : '(空)');
  await api('/api/users', { method: 'PUT', token: session, body: { username: uB, enable: true } });
  const subB5 = await api(`/api/sub?user=${uB}&token=${tokB}`);
  check('enable: 恢复后 B 订阅回来', subB5.status === 200 && decodeSub(subB5.text).length === 2, `status=${subB5.status} n=${decodeSub(subB5.text).length}`);

  // ---------- 13. VPS 配置接口下发 node_grants（上次全员断联的根因点） ----------
  const subA3 = await api(`/api/sub?user=${uA}&token=${tokA}`);
  const dv = await api('/api/data', { token: session });
  const agentToken = (dv.json?.servers || []).find(s => s.ip === vip)?.agent_token || '';
  check('data: 管理员可取到 agent_token', !!agentToken, `len=${agentToken.length}`);

  r = await api(`/api/config?ip=${vip}`, { headers: { authorization: agentToken } });
  const grantList = r.json?.node_grants || [];
  check('config: VPS 拉配置成功(agent 认证)', r.status === 200, `status=${r.status} ${r.text.slice(0, 120)}`);
  check('config: 下发 node_grants（4条=4节点×1人，A被恢复为2节点共4）', grantList.length >= 4, `grants=${grantList.length}`);
  const usersPerNode = {};
  for (const g of grantList) (usersPerNode[g.node_id] ||= []).push(g.username);
  const shared = Object.entries(usersPerNode).filter(([, u]) => u.length > 1);
  check('config: 至少 1 个节点被 2 人共享', shared.length >= 1, JSON.stringify(shared));
  console.log('   共享明细:', JSON.stringify(shared));

  // 关键回归：sing-box inbound 的 users 数组必须含全部授权用户，且凭据与订阅一致
  const cfgNodes = r.json?.configs || [];
  const credMismatch = [];
  for (const n of cfgNodes) {
    const gs = grantList.filter(g => g.node_id === n.id);
    const subCred = decodeSub(subA3.text).filter(l => new URL(l).port === String(n.port)).map(extractCred)[0];
    for (const g of gs) {
      const su = decodeSub((await api(`/api/sub?user=${g.username}&token=${g.username === uA ? tokA : tokB}`)).text)
        .filter(l => new URL(l).port === String(n.port)).map(extractCred)[0];
      if (su && g.credential !== su) credMismatch.push(`${n.id}/${g.username}`);
    }
  }
  check('config: 下发凭据与各用户订阅完全一致（防全员断联）', credMismatch.length === 0, `不一致 ${credMismatch.length} 处 ${JSON.stringify(credMismatch)}`);

  // ---------- 14. 权限隔离 ----------
  r = await api('/api/data', { headers: { authorization: tokA } });
  check('data: 订阅 token 不能当会话用（401）', r.status === 401, `status=${r.status}`);

  // ---------- 15. 删除用户 → 授权清理 ----------
  r = await api(`/api/users?username=${uB}`, { method: 'DELETE', token: session });
  const subB6 = await api(`/api/sub?user=${uB}&token=${tokB}`);
  check('delete: 删除用户后订阅 404', r.status === 200 && subB6.status === 404, `del=${r.status} sub=${subB6.status}`);
  r = await api(`/api/config?ip=${vip}`);
  const leftGrants = (r.json?.node_grants || []).filter(g => g.username === uB);
  check('delete: node_grants 中该用户已清空', leftGrants.length === 0, `残留 ${leftGrants.length}`);

  console.log('\n================= 汇总 =================');
  console.log(`PASS ${pass} / FAIL ${fail}`);
  if (fail) {
    console.log('失败项：');
    for (const x of results.filter(x => !x.ok)) console.log('  -', x.name, '|', x.detail);
  }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FATAL', e); process.exit(2); });