# KUI x Server Monitor Pro

## 项目赞助商

<p align="center">
  <a href="https://derouter.ai?ref=0oZZ1HVc" target="_blank">
    <strong>DeRouter</strong> - 基于区块链的透明大模型 API 网关
  </a>
</p>

DeRouter 提供 Claude、GPT 等模型 API 服务，支持透明可验证的模型调用。

- 官网：https://derouter.ai?ref=0oZZ1HVc
- X：https://x.com/derouter_net
- 有 API 需求或 Claude 账号托管需求可访问其官网了解详情。

<p align="center">
  <a href="https://bytevirt.com/aff.php?aff=209" target="_blank">
    <strong>ByteVirt</strong> - 高性价比云服务器与 VPS 服务商
  </a>
</p>

ByteVirt 提供多地域 VPS，适合部署 KUI VPS Agent、探针与代理节点。

- 官网：https://bytevirt.com/aff.php?aff=209
- 多地域机房与稳定网络，适用于 KUI 节点部署。

---

> **⚠️ 重要提示：一键部署后如果页面显示空白或 "Hello World"，请阅读下方 [一键部署故障排除](#一键部署故障排除)。**

KUI 是一个部署在 **单一 Cloudflare Worker** 的代理节点管理与服务器探针面板。Worker Assets 托管前端和 VPS 安装组件，D1 保存配置、用户、流量和探针数据，Durable Objects 提供实时 WebSocket；无需部署传统面板服务器或额外 Realtime Worker。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/a6216abcd/K-UI-workers)

## 一键部署

1. 点击上方 **Deploy to Cloudflare Workers**。
2. 登录 Cloudflare，选择账户并确认 Worker 名称。
3. Cloudflare 会自动创建并绑定 D1 数据库到 `DB`，同时创建实时状态需要的 Durable Objects。不要删除这些 bindings。
4. **首次访问：** 部署成功后直接打开 Worker 地址即可登录。
   - 如果页面正常显示登录界面，说明部署成功。
   - **如果页面显示空白、"Hello World" 或 1101 错误，请参照下方故障排除。**

### 一键部署故障排除

如果部署后页面无法正常加载，请按以下步骤排查：

**① 检查 D1 数据库绑定**
- 进入 Cloudflare Dashboard → Workers & Pages → 你的 Worker (kui)
- 左侧 → **Settings → Variables**
- 在 **D1 Database Bindings** 下找到 `DB`
- 如果没有绑定，点击 **Add binding**：
  - Variable name: `DB`
  - D1 database: 选择或创建一个 D1 数据库
- 绑定后点击 **Deploy** 重新部署

**② 检查 Durable Objects 绑定**
- 同一页面，在 **Durable Object Bindings** 下方应有以下两项：
  - `VPS_PRESENCE` → VpsPresence
  - `DASHBOARD_HUB` → DashboardHub
- 如果缺失，手动添加并重新部署

**③ 检查兼容性标志**
- 在 **Compatibility flags** 中添加：`assets_navigation_prefer_worker`
- 重新部署

**④ 如果仍然显示 Hello World**
- 在 Workers & Pages 页面找到你的 Worker
- 点击进入 → 点击右上角 **Quick Edit**
- 确认编辑器中的代码与实际仓库代码一致
- 如不一致，手动将 `src/worker.js` 内容复制进去，保存并重新部署

### ⑤ 首次打开面板：设置管理员

仓库**不预置任何默认账密**。部署完成后首次打开面板会进入「初始化管理员」页面：

- 用户名：字母 / 数字 / 点 / 横线 / 下划线，**不能是 `admin`**（该名字在订阅 SQL 里被保留为管理员标识）
- 密码：至少 12 位，需输入两次确认

提交后自动登录。管理员凭据以 PBKDF2-SHA256（10 万次迭代）哈希存入 D1 的 `admin_credentials` 表，**明文不落库、不进代码仓库**。

`POST /api/setup` 只能成功一次（数据库主键约束保证），初始化完成后重复调用返回 409。

> ⚠️ 初始化窗口：实例部署好到首次完成初始化之间，任何能访问该域名的人都可以抢先完成初始化并成为管理员。建议部署后立刻完成这一步；绑定自定义域名的实例尤其需要注意。

管理员可在面板内随时修改自己的密码。修改会同时轮换内部 HMAC 密钥并清空该账号的所有登录会话。

#### 用环境变量接管（可选）

若不想走面板初始化（例如希望用 CI 注入凭据），可在 `wrangler.prod.jsonc` 填 `ADMIN_USERNAME`，并执行 `npx wrangler secret put ADMIN_PASSWORD`。两者齐备时面板视为**已初始化**，不再显示初始化页，也不会被他人抢占。

内置住宅代理也已预设凭据：

```text
PROXY_USER=kui
PROXY_PASS=kui
```

启用住宅代理前，应在 Worker 的 **Variables and Secrets** 中将两项覆盖为独立的强 Secret 并重新部署。

## 自定义域名

在 Worker 的 **Settings → Domains & Routes → Add** 中绑定域名或子域名。绑定后直接使用该域名访问面板。

## 本地部署

适用于需要使用已有 D1、固定 Worker 名称或自行维护发布流程的场景。

```bash
git clone https://github.com/a6216abcd/K-UI-workers.git
cd K-UI-workers
npm install
npx wrangler login
npx wrangler deploy
```

当前 `wrangler.prod.jsonc` 已固定 D1 为 `kui-test-db`（20261004 正式版生产库，`database_id: ee9b5fe5-9023-4720-b2f5-bd2c3db12937`）。

- 换库：修改 `d1_databases[0].database_id` 后重新部署。
- 首次部署到全新账号时，删除该 `d1_databases` 条目，wrangler 会自动建库并建实时 Durable Objects。

部署命令（配置已收敛为单一文件）：

```bash
npx wrangler deploy --config wrangler.prod.jsonc
```

> 2026-10-04 起测试环境（`wrangler.test.jsonc` / Worker `kui-test`）已取消，
> test库 `kui-test-db` 升格为生产库。原生产库 `kui-v2-db` 已删除，
> 全量备份见 `_backup_20261004/`（不入库）。切换细节见
> `20261004正式版切换方案.md`。

生产环境请立即替换默认密码：

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler deploy
```

本地预览：

```bash
npm run dev
```

## 已内置实时服务

实时 WebSocket、Agent 在线状态、即时配置刷新、公开探针实时更新和观众频率自适应均已内置于主 Worker。

部署后无需配置：

- `REALTIME_URL`
- `PAGES_ORIGIN`
- 单独的 Realtime Worker
- 单独的 Realtime D1 或 Durable Objects

## VPS 接入

1. 登录 KUI，进入 **服务器与节点**。
2. 添加 VPS 名称和公网 IP。
3. 复制页面生成的 Full Deploy Command，以 `root` 在 VPS 执行。
4. 等待 Agent 回连后创建节点或使用"8 合 1"批量部署。

支持 XTLS-Reality、Hysteria2、TUIC、Trojan、H2/gRPC-Reality、AnyTLS、Naive、VLESS-Argo、Socks5 与 Dokodemo-door。

## 主要能力

- 多用户、订阅令牌、流量配额和到期管理。
- Mihomo/Clash 订阅导出，包括 AnyTLS。
- CPU、内存、磁盘、网络、TCP/UDP 与线路延迟探针。
- 多种预设探针主题、自定义 CSS 和背景。
- 原生、WARP、住宅代理和手动 SOCKS5 节点出口。
- 可选 Telegram 告警与订阅保护。
- Worker Cron 每 5 分钟检查离线节点。

## 架构

```text
浏览器 / VPS Agent
        |
Cloudflare Worker
  |- Worker Assets: 前端与 VPS 安装文件
  |- /api/*: KUI 后端接口
  |- /agent/ws、/dashboard/*、/public/ws：内置实时服务
  |- Cron: 离线检查
  |- D1 (DB): 配置、用户、节点、流量、探针数据
  `- Durable Objects: VPS 实时状态与 Dashboard Hub
```

## 注意事项

- 仓库不预置管理员账密：首次打开面板必须完成「初始化管理员」，否则所有接口返回 401。**部署后请立刻完成，避免初始化窗口被他人抢占。**
- 住宅代理凭据仍预设 `kui/kui`，公开使用前必须将 `PROXY_USER`、`PROXY_PASS` 覆盖为 Secret。
- 不要提交自定义 `ADMIN_PASSWORD`、D1 ID、Telegram Token 或代理凭据。
- `DB` 是固定 binding 名称，修改会导致后端无法访问数据库。
- 修改 Worker Variables 或 Bindings 后需要重新部署。
- 使用已有 D1 时，确认 `DB` 绑定指向正确数据库。
- `workspace-preview.html` 仅用于本地预览，不参与 Worker 静态资源发布。

## 开源协议

MIT
