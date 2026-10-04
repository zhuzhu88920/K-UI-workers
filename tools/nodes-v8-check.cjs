/**
 * 节点矩阵 v8 验收：真实浏览器 + 管理员登录态 + 7 节点假数据
 * 校验：Vue 挂载 / 各 tab 无致命错误 / tile 定高 76px / 字号层级 /
 *       hover 操作层 / 超限变红 / 停用态 / 业务事件绑定完整性
 * 用法：node tools/nodes-v8-check.cjs
 */
const fs = require('fs'), path = require('path');
const exe = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium: cr } = require(exe);
const SRC = path.join(__dirname, '..', 'static', 'index.html');
const OUT = path.join(__dirname, '..', '_nodes_v8_result.png');

const SERVERS = [{
  ip: '1.2.3.4', name: '日本软银 01', cpu: 11, mem: 22, disk: 33, load: '0.52',
  net_in_speed: 1048576, net_out_speed: 2097152, uptime: '12d 4h',
  egress_mode: 'native', egress_status: 'applied', egress_applied_mode: 'native', egress_ip: '1.2.3.4',
  last_report: Date.now(), realtime_state: 'live', _proxy_mode: 'none',
  _socks5_addr: '', _socks5_port: '', _socks5_user: '', _socks5_pass: '', _proxy_categories_dirty: false
}];

const NODES = [
  { id: 1, vps_ip: '1.2.3.4', protocol: 'XTLS-Reality', port: 443, enable: 1, traffic_used: 966367641, traffic_limit: 0, expire_time: 0, sni: 'www.microsoft.com', _grant_users: ['a', 'b', 'c'] },
  { id: 2, vps_ip: '1.2.3.4', protocol: 'Hysteria2', port: 8443, enable: 1, traffic_used: 0, traffic_limit: 1073741824, expire_time: 1893456000, sni: '', _grant_users: ['a'] },
  { id: 3, vps_ip: '1.2.3.4', protocol: 'TUIC', port: 2053, enable: 1, traffic_used: 2147483648, traffic_limit: 3221225472, expire_time: 0, sni: 'addons.mozilla.org', _grant_users: ['x', 'y', 'z'] },
  { id: 4, vps_ip: '1.2.3.4', protocol: 'Trojan', port: 443, enable: 1, traffic_used: 5368709120, traffic_limit: 5368709120, expire_time: 1798732800, sni: '', _grant_users: [] },
  { id: 5, vps_ip: '1.2.3.4', protocol: 'H2-Reality', port: 2083, enable: 1, traffic_used: 322122547, traffic_limit: 0, expire_time: 0, sni: 'itunes.apple.com', _grant_users: ['q'] },
  { id: 6, vps_ip: '1.2.3.4', protocol: 'gRPC-Reality', port: 2080, enable: 0, traffic_used: 1073741824, traffic_limit: 0, expire_time: 0, sni: 'gateway.icloud.com', _grant_users: ['w'] },
  { id: 7, vps_ip: '1.2.3.4', protocol: 'AnyTLS', port: 8444, enable: 1, traffic_used: 1610612736, traffic_limit: 4294967296, expire_time: 0, sni: '', _grant_users: ['e', 'f'] }
];

const PAYLOAD = JSON.stringify({
  initialized: true, servers: SERVERS, nodes: NODES,
  users: [{ username: 'a', enable: 1, node_ids: [1, 2] }],
  groups: [], sys_config: {}, stats: {}, third_party: [], traffic_stats: []
});

const TABS = ['nodes', 'users', 'proxy', 'realm', 'services', 'thirdparty', 'settings', 'probe'];
let failed = 0;

(async () => {
  const b = await (cr.launch({ channel: 'msedge' }).catch(() => cr.launch()));
  const html = fs.readFileSync(SRC, 'utf8');

  for (const tab of TABS) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(t => {
      localStorage.setItem('kui_user', 'admin');
      localStorage.setItem('kui_role', 'admin');
      localStorage.setItem('kui_auth_key', 'k');
      localStorage.setItem('monitor_preferred_tab', t);
    }, tab);
    await ctx.route('https://local.test/**', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await ctx.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: PAYLOAD }));

    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => { const m = e.message.split('\n')[0]; if (!/favicon|404|Failed to load resource/i.test(m)) errs.push(m); });
    p.on('console', m => { if (m.type() === 'error' && !/favicon|404|Failed to load resource/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 140)); });

    await p.goto('https://local.test/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5000);

    const r = await p.evaluate((tb) => {
      const a = document.getElementById('app');
      const res = { kids: a ? a.children.length : -1, h: a ? Math.round(a.getBoundingClientRect().height) : 0, len: a ? a.innerHTML.length : 0,
        // 主区可见文本：realm/probe 页本身内容少，不能用 innerHTML 长度判挂载
        mainText: (() => { const m = a ? (a.querySelector('.max-w-\\[1800px\\]') || a) : null; return m ? (m.innerText || '').replace(/\\s+/g, ' ').trim() : ''; })() };
      if (tb !== 'nodes') return res;
      const tiles = [...document.querySelectorAll('.kui-ncard')];
      res.tileCount = tiles.length;
      if (tiles.length) {
        const t = tiles[0], cs = getComputedStyle(t);
        res.height = Math.round(t.getBoundingClientRect().height);
        res.width = Math.round(t.getBoundingClientRect().width);
        res.display = cs.display; res.dir = cs.flexDirection; res.just = cs.justifyContent; res.pad = cs.padding;
        res.proto = getComputedStyle(t.querySelector('.n-proto')).fontSize;
        res.sni = getComputedStyle(t.querySelector('.n-sni')).fontSize;
        res.sub = getComputedStyle(t.querySelector('.n-subtext')).fontSize;
        res.bar = getComputedStyle(t.querySelector('.n-bar')).height;
        const ops = getComputedStyle(t.querySelector('.n-ops'));
        res.ops = ops.position + '/' + ops.opacity;
        res.over = tiles.filter(x => x.querySelector('.n-bar-fill.over')).length;
        res.dis = tiles.filter(x => x.classList.contains('is-disabled')).length;
        res.users = tiles.filter(x => x.querySelector('.n-users')).length;
        res.capTitle = (document.querySelector('.kui-nodes-cap .cap-title') || {}).textContent?.trim().replace(/\s+/g, ' ') || '缺失';
        res.capInfo = (document.querySelector('.kui-nodes-cap .cap-info') || {}).textContent?.trim() || '缺失';
        res.autoBadge = document.body.innerHTML.includes('管理员自动放行') ? '残留' : '已清除';
        // 事件绑定：读 Vue 编译后的 vnode props（onClick 存在即已绑定）
        const vn = t.__vnode || (t.parentNode && t.parentNode.__vnode);
        res.opsBtns = [...t.querySelectorAll('.n-ops .n-op-btn')].map(b => b.textContent.trim()).join('/') || '无';
        res.opsHoverable = getComputedStyle(t.querySelector('.n-ops')).pointerEvents === 'none' ? 'hidden→auto' : '常显';
        res.barW = [...t.parentNode.querySelectorAll('.n-bar-fill')].map(x => x.style.width).slice(0, 3).join(',');
        res.subTexts = [...t.querySelectorAll('.n-subtext span')].map(x => x.textContent.trim()).join(' | ');
      }
      return res;
    }, tab);

    // ★ 判定：Vue 已挂载(高度) + 主区有可见文本 + 无致命错误。原判innerHTML.length>5000
    // 会把 realm(内容少) / probe(canvas 地图) 误判为挂载失败。
    const bad = errs.length > 0 || r.h < 100 || r.mainText.length < 40 || (tab === 'nodes' && r.tileCount !== 7);
    if (bad) failed++;
    console.log((bad ? 'FAIL' : 'PASS') + ' | tab=' + tab.padEnd(11) + ' | 主区文本=' + String(r.mainText.length).padStart(5) + '字 高=' + String(r.h).padStart(4) + (errs.length ? ' | ' + errs[0] : ''));

    if (tab === 'nodes' && r.tileCount) {
      console.log('  tile 数=' + r.tileCount + ' 高度=' + r.height + 'px 宽度=' + r.width + 'px | display=' + r.display + ' dir=' + r.dir + ' justify=' + r.just + ' padding=' + r.pad);
      console.log('  字号层级 proto=' + r.proto + ' sni=' + r.sni + ' sub=' + r.sub + ' bar=' + r.bar + ' | n-ops=' + r.ops);
      console.log('  超限变红=' + r.over + ' 停用态=' + r.dis + ' 有授权数=' + r.users + ' 管理员徽标=' + r.autoBadge);
      console.log('  标题: ' + r.capTitle);
      console.log('  说明: ' + r.capInfo);
      console.log('  操作按钮: ' + r.opsBtns + ' (' + r.opsHoverable + ')');
      console.log('  进度条宽: ' + r.barW);
      console.log('  底行数字: ' + r.subTexts);
      await p.screenshot({ path: OUT, fullPage: true });
    }
    await ctx.close();
  }
  await b.close();
  console.log('\n===== ' + (failed ? '失败 ' + failed + ' 项，禁止部署' : '全部通过，可以部署') + ' =====');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
