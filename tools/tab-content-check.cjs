/**
 * 逐 tab 内容体检：真实浏览器 + 管理员登录态 + mock 数据
 * 登录后逐个点击 tab，量测每个 tab 主容器是否真的有内容（不只是框架）
 * 用法：node tools/tab-content-check.cjs [html路径] [标签]
 */
const fs = require('fs'), path = require('path');
const exe = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium: cr } = require(exe);

const SRC = process.argv[2] || path.join(__dirname, '..', 'static', 'index.html');
const LABEL = process.argv[3] || path.basename(SRC);

const PAYLOAD = JSON.stringify({
  initialized: true,
  servers: [
    { ip: '1.2.3.4', name: 'VPS-A', cpu: 11, mem: 22, disk: 33, load: '0.5', net_in_speed: 1048576, net_out_speed: 2097152, uptime: '12d', egress_mode: 'native', egress_status: 'applied', egress_applied_mode: 'native', egress_ip: '1.2.3.4', last_report: Date.now(), realtime_state: 'live', _proxy_mode: 'none', _socks5_addr: '', _socks5_port: '', _socks5_user: '', _socks5_pass: '' },
    { ip: '5.6.7.8', name: 'VPS-B', cpu: 5, mem: 10, disk: 20, load: '0.2', net_in_speed: 1048576, net_out_speed: 1048576, uptime: '3d', egress_mode: 'native', egress_status: 'applied', egress_applied_mode: 'native', egress_ip: '5.6.7.8', last_report: Date.now(), realtime_state: 'live', _proxy_mode: 'none', _socks5_addr: '', _socks5_port: '', _socks5_user: '', _socks5_pass: '' }
  ],
  nodes: [
    { id: 1, vps_ip: '1.2.3.4', protocol: 'XTLS-Reality', port: 443, enable: 1, traffic_used: 966367641, traffic_limit: 0, expire_time: 0, sni: 'www.microsoft.com', _grant_users: ['a'] },
    { id: 2, vps_ip: '1.2.3.4', protocol: 'Hysteria2', port: 8443, enable: 1, traffic_used: 0, traffic_limit: 1073741824, expire_time: 1893456000, sni: '', _grant_users: ['a', 'b'] },
    { id: 3, vps_ip: '5.6.7.8', protocol: 'Trojan', port: 443, enable: 1, traffic_used: 100, traffic_limit: 0, expire_time: 0, sni: '', _grant_users: [] }
  ],
  users: [
    { username: 'alice', password_hash: 'x', enable: 1, remark: '测试用户', sub_expire: 1893456000, traffic_limit: 10737418240, traffic_used: 123456, node_ids: [1, 2] }
  ],
  groups: [], sys_config: {}, stats: {}, third_party: [], traffic_stats: [], realm: [], services: []
});


(async () => {
  const b = await (cr.launch({ channel: 'msedge' }).catch(() => cr.launch()));
  const html = fs.readFileSync(SRC, 'utf8');
  const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('kui_user', 'admin');
    localStorage.setItem('kui_role', 'admin');
    localStorage.setItem('kui_auth_key', 'k');
    localStorage.setItem('monitor_preferred_tab', 'nodes');
  });
  await ctx.route('https://local.test/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: PAYLOAD }));

  // ★ 静态门禁：整块 div 开闭必须配平（缺一个闭合会把后续 tab 拖进 v-for 作用域）
  const htmlRaw = fs.readFileSync(SRC, 'utf8');
  const openDiv = (htmlRaw.match(/<div\b/g) || []).length;
  const closeDiv = (htmlRaw.match(/<\/div>/g) || []).length;
  const balanced = openDiv === closeDiv;
  console.log('静态门禁| <div> 开=' + openDiv + ' 闭=' + closeDiv + ' 差=' + (openDiv - closeDiv) + ' => ' + (balanced ? '配平 OK' : '★不平衡，禁止部署'));
  if (!balanced) { await b.close(); process.exit(2); }
  console.log('');

  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => { const m = e.message.split('\n')[0]; if (!/favicon|404/i.test(m)) errs.push(m); });
  await p.goto('https://local.test/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(5000);

  console.log('===== ' + LABEL + ' =====');
  // 先量一次登录后默认视图
  const overview = await p.evaluate(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    return { textLen: t.length, tabs: [...document.querySelectorAll('.kui-admin-tab')].map(x => x.textContent.trim()), snippet: t.slice(0, 200) };
  });
  console.log('tab 按钮: ' + overview.tabs.join(' / '));
  console.log('登录后可见文本 ' + overview.textLen + ' 字: ' + overview.snippet);
  console.log('');

  const tabCount = overview.tabs.length;
  for (let i = 0; i < tabCount; i++) {
    const before = errs.length;
    const name = await p.evaluate(idx => {
      const bs = [...document.querySelectorAll('.kui-admin-tab')];
      bs[idx].click();
      return bs[idx].textContent.trim();
    }, i);
    await p.waitForTimeout(1200);
    const m = await p.evaluate(() => {
      const app = document.getElementById('app');
      // tab 主容器：v-if 控制的第一层大容器
      const t = (app ? (app.innerText || '') : '').replace(/\s+/g, ' ').trim();
      const hi = document.querySelector('.kui-admin-tab.bg-white');
      // 统计主容器内可见子树，排除导航栏
      const main = app ? app.querySelector('.max-w-\\[1800px\\]') || app : null;
      const mainText = main ? (main.innerText || '').replace(/\s+/g, ' ').trim() : '';
      return {
        mainTextLen: mainText.length,
        mainSnippet: mainText.slice(0, 110),
        hi: hi ? hi.textContent.trim() : '?',
        inputs: main ? main.querySelectorAll('input:not([type=hidden]),textarea,select').length : 0,
        btns: main ? main.querySelectorAll('button').length : 0,
        tables: main ? main.querySelectorAll('table').length : 0,
        cards: main ? main.querySelectorAll('.kui-ncard').length : 0,
        appH: app ? Math.round(app.getBoundingClientRect().height) : 0
      };
    });
    const newErr = errs.slice(before);
    const ok = m.mainTextLen > 40;
    if (!ok) process.exitCode = 1;
    console.log((ok ? 'PASS' : '★空') + ' | ' + String(i) + ' ' + name.padEnd(10) + ' 主区文本' + String(m.mainTextLen).padStart(5) + '字 按钮' + String(m.btns).padStart(3) + ' 输入' + String(m.inputs).padStart(3) + ' 表' + m.tables + ' tile' + m.cards + ' 高' + m.appH + (newErr.length ? ' | ERR ' + newErr[0] : ''));
    if (!ok) console.log('       └ 实际内容: "' + m.mainSnippet + '"');
  }
  console.log('总错误: ' + (errs.length ? errs.join(' | ') : '无'));
  await b.close();
  if (process.exitCode) { console.log('\n===== 有 tab 内容为空，禁止部署 ====='); process.exit(1); }
  console.log('\n===== 所有 tab 主区均有内容 =====');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
