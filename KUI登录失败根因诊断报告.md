# K-UI 登录失败 · 根因诊断报告

- 日期：2026-10-04
- 目标域名：`https://kui.zhuyongfu.cn`
- 方法：Playwright + Chromium 1217 真实浏览器，`--no-proxy-server` 对照实验
- 结论：**代码无缺陷，根因是本机系统代理**

---

## 一、用户提供的控制台日志归属判定

| 日志 | 实际来源 | 是否 K-UI 问题 |
|---|---|---|
| `contentscript.js:14083 MaxListenersExceededWarning`（close / end listeners） | 浏览器扩展注入脚本（Vue Devtools / 钱包类扩展） | 否，纯噪音 |
| `ObjectMultiplex - orphaned data for stream "app-init-liveness"` | MetaMask 类钱包扩展的内部通道日志 | 否，纯噪音 |
| `cdn.tailwindcss.com should not be used in production` | Tailwind CDN 官方提示 | 否，且**反证 CDN 可达** |

第三条是关键：该警告只有在 `cdn.tailwindcss.com` **成功下载并执行**后才会打印。
因此 Vue（unpkg → jsdelivr 回退）同样可达。此前"Vue CDN 加载失败"的判断不成立。

---

## 二、后端接口实测（curl 直连）

| 接口 | 状态码 | 响应 | 判定 |
|---|---|---|---|
| `GET /api/setup` | 200 | `{"initialized":true}` | 正常 |
| `POST /api/login`（错误密码） | 401 | `{"error":"Unauthorized"}` | 正常（预期拒绝） |
| `GET /api/probe/public` | 200 | `is_public=true` | 正常 |
| `GET /api/data`（无 token） | 401 | — | 正常 |
| `GET /favicon.ico` | 404 | — | 无害，缺图标 |

结论：后端、登录接口、鉴权逻辑**全部正常**。

---

## 三、浏览器端实测对照实验

### 实验 A：Chromium 继承 Windows 系统代理

```
playwright-cli open https://kui.zhuyongfu.cn/
→ Error: net::ERR_CONNECTION_CLOSED at https://kui.zhuyongfu.cn/
```

### 实验 B：Chromium 加 `--no-proxy-server` 绕过代理

| 检查项 | 结果 |
|---|---|
| 页面标题 | `KUI x Server Monitor` |
| `window.Vue` | `object` |
| Vue 已挂载 | `true` |
| `window.tailwind` | `true` |
| 页面 JS 异常 | **0 条** |
| 失败的网络请求 | **0 条** |
| 探针数据 | 3 台服务器，2 在线，节点卡片、地图、统计数据全部正常渲染 |

登录流程实测（用错误密码真实提交）：

| 步骤 | 结果 |
|---|---|
| 点击「👨‍💻 KUI 管理面板」 | 弹窗出现，用户名/密码输入框可见 |
| 填入凭据并点「登 入 系统」 | 发出 `POST /api/login` → 401 |
| 失败后弹窗 | 保持显示，未误关 |

结论：登录链路从前端到后端**完全正常**。

---

## 四、根因

```
Windows 系统代理 = 127.0.0.1:10808（Clash / V2rayN 类）
        ↓
Chromium / Edge 自动继承该代理
        ↓
代理规则把 kui.zhuyongfu.cn 也送进了代理隧道
        ↓
代理出口无法建立到 Cloudflare 的 TLS 连接 → ERR_CONNECTION_CLOSED
        ↓
页面拿不到 HTML → 「Vue 加载失败」红屏；或加载了但接口全失败 → 点登录没反应
```

解释全部现象：

| 现象 | 解释 |
|---|---|
| Chrome / Edge 无法登录、首页资源加载失败 | 走代理，连接被关闭 |
| Safari 可以登录 | macOS Safari 默认不继承该系统代理，走直连 |
| 控制台只有扩展噪音，没有 K-UI 报错 | 请求根本没到服务器，JS 从未执行到出错的程度 |
| 换网络/关代理就正常 | 符合代理链路故障特征 |

---

## 五、修复方案（用户侧，无需改代码）

### 方案 1（推荐）：代理软件内加直连规则

在 Clash / V2rayN 的规则组中，把自有域名设为 DIRECT：

```yaml
rules:
  - DOMAIN-SUFFIX,zhuyongfu.cn,DIRECT
  - DOMAIN-SUFFIX,cc.cd,DIRECT
  - DOMAIN-SUFFIX,eu.org,DIRECT
```

V2rayN（GUI）：订阅 → 右键配置 → 规则集 → 在规则最前面插入以上三条。

### 方案 2：浏览器内绕过

Chrome / Edge 地址栏访问：

- `chrome://settings/system` → 打开「使用代理设置」→ 在「不代理的服务器」加入 `*.zhuyongfu.cn`
- 或启动参数 `--proxy-server="direct://;http=127.0.0.1:10808"`，把自有域名排除

### 方案 3：改用独立调试/生产域名

若不想动代理规则，可给 Worker 绑一个不走代理习惯的域名，或直接用
`kui-v2.andox.workers.dev`（但该域名当前本机直连也不通，见下）。

---

## 六、附带发现（非阻塞）

| # | 发现 | 说明 | 建议 |
|---|---|---|---|
| 1 | `is_public=true` 时不自动弹登录框 | 需手动点「KUI 管理面板」才弹。这是设计行为，但用户容易误判为"坏了" | 可考虑首次访问无 localStorage 时自动弹窗 |
| 2 | `GET /favicon.ico` 404 | 无图标 | 可加一个 favicon |
| 3 | 密码框不在 `<form>` 内 | Chrome 提示 `[DOM] Password field is not contained in a form` | 影响密码管理器自动填充，非功能缺陷 |

---

## 七、本机网络现状备注

- `https://kui.zhuyongfu.cn` 直连 **200**（可用）
- `https://kui-v2.andox.workers.dev` 直连 **000**（workers.dev 被 SNI 封锁，属已知现象）
- 代理 `http://127.0.0.1:10808` → `https://www.cloudflare.com` 返回 **000 / exit 35**（TLS 失败）
  → 当前沙箱内代理链路本身也不通，curl 抓取线上资源需直连或修好代理