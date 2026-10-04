# K-UI v2 故障修复报告（部署 1573bac5）

日期：2026-10-04
上一基线：`115c7d33`（已打 tag `safe-115c7d33`）
本次版本：`1573bac5-4bed-4149-97a0-9ae47fec37f8`

---

## 基线固化

| 项 | 值 |
|---|---|
| CF 版本 ID | `115c7d33-b398-4135-82e9-bd46db2e0c34` |
| git tag | `safe-115c7d33` |
| 工作区快照 | `_baseline/115c7d33/`（14 个文件） |
| index.html md5 | `577b21ac2d68b82ea93af3bb757c42db` |

回滚方式（二选一）：
```bash
git checkout safe-115c7d33
npx wrangler rollback 115c7d33-b398-4135-82e9-bd46db2e0c34
```

---

## ① 管理员订阅 500 —— 已修复

### 根因
`functions/api/[[path]].js` 的 `/api/sub` 管理员分支参数数量不匹配：

```js
let sqlParams = [now];                              // 预置 1 个
if (reqUser === adminUser) {
    query = `... AND (expire_time = 0 OR expire_time > ?)`;   // SQL 只有 1 个 ?
    sqlParams.push(now);                            // 又塞 1 个 → 共 2 个
}
```

D1 收到 2 个绑定参数但SQL 只有 1 个占位符 → 抛错 → `scriptThrewException` → HTTP 500。

### 定位证据
GraphQL `workersInvocationsAdaptive` 查到 6 小时内 8 条 `scriptThrewException`（北京时间 00:48~ 01:57），
同时 `/api/setup`、`/api/probe/public` 均 200 —— 排除环境问题，锁定后端异常。

### 修复
`sqlParams` 不再预置，由各分支自行赋值。

### 验证
| 请求 | 修复前 | 修复后 |
|---|---|---|
| 管理员订阅（有效 token） | **500** | **200**，4404 字节 |
| 错误 token | 404 | 404（正常） |

---

## ② VPS 重启死循环 —— 已修复（`report_status` 确为真凶）

### 现象
VPS 日志每 40~90 秒重复一轮：
```
components updated, restarting
updated version failed readiness checks
新版本启动失败，恢复 last-good 组件
```
12 分钟内sing-box 被停止 12 次，客户端被反复踢断。

### 根因
`agent.py` 的 WebSocket 断线宽限判断没有 `force_http` 短路：

```python
if realtime_channel and realtime_channel.enabled and not websocket_sent \
   and time.time() - realtime_channel.last_disconnected < 30:
    return False        # force_http=True 也照样进这里
```

启动就绪检查调用的是 `report_status(..., force_http=True)`，语义明确是「这次必须走 HTTP 并如实返回成败」。
但新 agent 启动瞬间 WebSocket 必然尚未连上，`last_disconnected` 刚刷新 <30 秒 → **必然 return False**。

死循环的完整闭环：

```
新 agent 启动 → WS 未连上 → 就绪检查必败 → 抛 SystemExit(1)
   → launcher 回滚组件（kui.sh）
   → CF 侧版本并未随回滚改变
   → 下一轮 check_for_update 算出相同 sha256 → 又装同一个坏版本
   → 再次失败 …… 每轮重启一次 sing-box
```

### 三处修复
1. **宽限判断加 `not force_http and` 短路** —— 让 `force_http=True` 真正生效。
2. **就绪检查逐项求值并打印具体失败项**：
   `config_fetch_or_apply_failed` / `singbox_service_unhealthy` / `status_report_failed`。
   原来三个条件合并成一句话，线上只能看到「失败」，无法定位是哪一项。
3. **新增版本熔断机制**：
   - `.update-pending` 记录本次安装的 `component_hashes`
   - 就绪检查失败时把指纹写入 `/opt/kui/.quarantined-versions`
   - `check_for_update` 读到熔断表中的 sha256 直接跳过

第3 点是死循环的真正闭环。**CF 侧版本不随 VPS 回滚变化**，任何「下发新版本 → 失败回滚」机制都必须配版本熔断，否则天生无限循环。

---

## ③ AnyTLS / Naive「订阅里没有」—— 实测推翻，属误判

### 实测结果
线上订阅 `base64 -d` 后统计，8 端口 × 2 台 VPS = **16 条一个不缺**：

| 协议 | 条数 |
|---|---|
| vless | 6（XTLS/H2/gRPC × 2 台） |
| anytls | 2 |
| naive | 2 |
| hysteria2 | 2 |
| trojan | 2 |
| tuic | 2 |
| socks5 | 2（住宅代理） |

凭据与 VPS 侧 `config.json` 逐条吻合，例如 AnyTLS password（22 字符 base64，已脱敏）一致。

### 推测的真实原因
**「订阅输出没有」与「客户端看不到」是两件事**：

- 面板内的**订阅解析器**（`functions/api` 中 `rawLC.startsWith(...)` 那串分支）只支持
  `vmess / vless / trojan / hysteria2 / tuic / naive+https / ss`，
  **没有 `anytls://` 分支** → 导入第三方订阅时 AnyTLS 节点被静默丢弃。
- v2rayN 旧版本也不识别 `anytls://` scheme。

即服务端输出一直正常，问题在解析端与客户端。

---

## ④ H2+Reality / gRPC+Realm 不通 —— 客户端传输层问题，服务端无需改

### 判定依据
- **Xray 已移除 HTTP/2 传输层**，`type=http` 在 Xray 侧直接被拒绝（不会改写为 XHTTP）。
  服务端 sing-box 的 `transport.type=http` 配得再正确也无法工作。
- gRPC 传输层 Xray 仍保留，但 Reality + gRPC 组合兼容性差，官方建议 gRPC 场景回退纯 TLS。
- 服务端 `agent.py` 生成 H2/gRPC inbound 的逻辑**本身没错**，
  与 fscarmen/sing-box.sh 官方 H2+Reality / gRPC+Reality 模板结构一致。

### 结论
属于「客户端不支持」，非服务端 bug。8 协议矩阵保留它们无害；
若要精简可从 `static/index.html` 的 `protocolSequence` 中去掉。

---

## ⑤ 复制按钮改为 toast 自动消失

`copyCommand` 从 `alert(msg)`（必须点「确定」）改为 `showToast(msg)`
（项目已有 2.6 秒自动消失实现），一处替换覆盖全部 10 个复制入口。

`resetMySubLink` 的重置令牌属危险操作，`confirm` 二次确认保留，仅末尾提示改为 toast。

---

## 部署前校验记录

```bash
npx esbuild "functions/api/[[path]].js" --outfile=/tmp/_c.js --format=esm   # 通过
python -c "import ast; ast.parse(open('static/vps/agent.py',encoding='utf-8').read())"  # 通过
# 残留检查：node_grants / grant_uuid / allowed_users / granted_to / SIGHUP  全部为 0
```

## 需要用户在 VPS 上确认的

```bash
sudo journalctl -u kui-agent --no-pager --since "30 minutes ago" | grep -iE "readiness|quarantin|skipping" | tail -20
```

预期：不再出现 `updated version failed readiness checks`；
若仍出现，现在会明确报出具体失败项，且该版本会被熔断、不再重复安装。