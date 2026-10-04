/**
 * 部署前强校验：真实浏览器 + 真实数据 + 真实登录态渲染
 * 任何一项不通过都禁止部署。
 *
 * 用法：node tools/predeploy-check.cjs [目标URL]
 * 默认拦截 https://kui.zhuyongfu.cn/ 用本地 static/index.html 渲染，不碰生产。
 */
const exe = 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium: cr } = require(exe);
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'static/index.html');

// 覆盖各种数据形态：空 / 单机 / 多机 / 有节点 / 停用节点 / 出错出口
const DATA_CASES = {
  '空数据': { servers: [], nodes: [], users: [], groups: [] },
  '单机无节点': { servers: [{ ip: '1.2.3.4', name: 'A', cpu: 1, mem: 2, disk: 3, load: '0.1', egress_mode: 'native', egress_status: 'ok' }], nodes: [], users: [], groups: [] },
  '单机多节点': {
    servers: [{ ip: '1.2.3.4', name: 'A', cpu: 11, mem: 22, disk: 33, load: '0.5', net_in_speed: 100, net_out_speed: 200, uptime: '3d', egress_mode: 'native', egress_status: 'ok' }],
    nodes: [
      { id: 1, vps_ip: '1.2.3.4', protocol: 'XTLS-Reality', port: 443, enable: 1, traffic_used: 1024, traffic_limit: 0, expire_time: 0, sni: 'a.com' },
      { id: 2, vps_ip: '1.2.3.4', protocol: 'Hysteria2', port: 8443, enable: 1, traffic_used: 0, traffic_limit: 1073741824, expire_time: 1893456000, sni: '' },
      { id: 3, vps_ip: '1.2.3.4', protocol: 'VLESS-Argo', port: 2053, enable: 0, traffic_used: 5, traffic_limit: 0, expire_time: 0, sni: '等待中' }
    ], users: [{ username: 'lisi', enable: 1, node_ids: [1] }], groups: []
  },
  '多机': {
    servers: [
      { ip: '1.2.3.4', name: 'A', cpu: 1, mem: 2, disk: 3, load: '0.1', egress_mode: 'warp_dual', egress_status: 'ok' },
      { ip: '5.6.7.8', name: 'B', cpu: 4, mem: 5, disk: 6, load: '0.2', egress_mode: 'residential', egress_status: 'pending' },
      { ip: '9.9.9.9', name: 'C', cpu: 7, mem: 8, disk: 9, load: '0.3', egress_mode: 'socks5', egress_status: 'failed', egress_error: '认证失败' }
    ],
    nodes: [{ id: 1, vps_ip: '1.2.3.4', protocol: 'Trojan', port: 443, enable: 1, traffic_used: 0, traffic_limit: 0, expire_time: 0, sni: '' }],
    users: [], groups: []
  }
};

const TABS = ['nodes', 'users', 'proxy', 'realm', 'services', 'thirdparty', 'settings', 'probe'];

(async () => {
  const html = fs.readFileSync(SRC, 'utf8');
  let failed = 0;
  const browser = await cr.launch({ channel: 'msedge' }).catch(() => null) || await cr.launch();

  for (const [dname, data] of Object.entries(DATA_CASES)) {
    for (const tab of TABS) {
      const c = await browser.newContext();
      const p = await c.newPage();
      const errs = [];
      p.on('console', m => { if (m.type() === 'error' && /Cannot read|TypeError|is not defined|undefined is not/.test(m.text())) errs.push(m.text().split('\n')[0].slice(0, 130)); });
      p.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0, 130)));
      await p.route('https://kui.zhuyongfu.cn/', r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await p.route('**/api/data*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }));
      await p.addInitScript((t) => {
        localStorage.setItem('kui_user', 'admin'); localStorage.setItem('kui_role', 'admin');
        localStorage.setItem('kui_auth_key', 'k'); localStorage.setItem('monitor_preferred_tab', t);
      }, tab);
      await p.goto('https://kui.zhuyongfu.cn/', { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(4000);
      const r = await p.evaluate(() => {
        const a = document.getElementById('app');
        if (!a) return { kids: -1 };
        // 根节点数必须为 1：>1 说明 DOM 嵌套错位
        return { kids: a.children.length, h: Math.round(a.getBoundingClientRect().height) };
      });
      await c.close();
      const bad = errs.length > 0 || r.kids !== 1;
      if (bad) failed++;
      console.log(
        (bad ? 'FAIL' : 'PASS') + ' | ' + dname.padEnd(12) + ' | tab=' + tab.padEnd(11) +
        ' | 根节点=' + r.kids + ' 高=' + r.h + (errs.length ? ' | ' + errs[0] : '')
      );
    }
  }
  await browser.close();
  console.log('\n===== ' + (failed ? '失败 ' + failed + ' 项，禁止部署' : '全部通过，可以部署') + ' =====');
  process.exit(failed ? 1 : 0);
})();
