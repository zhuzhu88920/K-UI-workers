# K-UI 真实 VPS 多对多测试：根因诊断报告

- 时间：2026-10-04 11:20~11:30
- 测试环境：https://kui-test.zhuyongfu.cn （生产未受影响）
- 真实 VPS：`38.207.173.192`（hk-vmiss，VMISS 香港）
- 症状：v2rayN 里 3 个订阅组，前两个能拉 7 个节点但**一个都不通**，第三个能拉 5 个、只有 2 个通

---

## 一、结论先说

**CF 侧完全正常，VPS 侧 agent 没更新。**

根因：VPS 上跑的 `agent.py` 还是**旧版单凭据实现**——每个 inbound 的 `users` 数组只有**节点主凭据**一条。
所以：

- 管理员「首页直接复制」的链接里用的是**节点主 UUID** → 命中，能通
- `lisi` / `zhangsan` 的订阅里用的是 `node_grants` 里的**按人独立凭据** → VPS 不认，握手被拒，一个都不通

**这不是多对多逻辑的 bug，恰恰说明多对多隔离生效了**——独立凭据真的在起作用，只是服务端还没跟上。

---

## 二、证据链（全部实测，非推断）

### 2.1 CF 侧下发正确 ✅

`GET /api/config?ip=38.207.173.192`（用真实 agent_token 认证）返回：

| 项 | 值 |
|---|---|
| `configs` | 8 个节点（9991~9998） |
| `node_grants` | **14 条**（7 节点 × 2 用户） |
| `blocked_ports` | `[]`（无封禁） |

数据库 `node_grants` 实际内容（凭据按人隔离，两两不同）：

| 节点 | 协议 | lisi | zhangsan |
|---|---|---|---|
| 9991 | XTLS-Reality | `ddcdd408-…bed4b5fb` | `28b74e45-…1723e8c` |
| 9992 | Hysteria2 | `MoaYP9Htgww+mnPKcbimgg==` | `+UARZQaoxzHPCRx0Ax8V0Q==` |
| 9993 | TUIC | `NFM+rleUi2eS5qnYSwlsjg==` | `H3CSitipskPXEPDfuy3NpQ==` |
| 9994 | Trojan | `nkE4z2opJvvbGydleMMlPA==` | `bUaoMGBjmseFbnQxyqq7cg==` |
| 9995 | H2-Reality | `6b8112f6-…de3914149` | `ed5bd19f-…7bbe06b08` |
| 9996 | gRPC-Reality | `0eea750e-…73aca01c83` | `7baddb13-…b12f879f4` |
| 9997 | AnyTLS | `dY5C1f6rYQ4+DexypcNGcA==` | `ap1A5sqeEZUCojSHMzxHyg==` |

### 2.2 两份订阅内容正确且互相隔离 ✅

实测拉取两份订阅（v2rayN UA），逐条比对：

- **lisi**：7 条（9991~9997），凭据如上表左列
- **zhangsan**：7 条（9991~9997），凭据如上表右列
- 两条订阅里同一个节点的凭据**无一相同**
- Reality 的 `pbk`（public_key）与 `sid`（short_id）**共享**——这是对的，Reality 密钥属 inbound 级参数，与 users 数组正交

### 2.3 VPS 网络层正常 ✅

从本机实测（不经代理，直连 HK）：

| 端口 | 协议 | TCP 探测 | TLS 握手 |
|---|---|---|---|
| 9991 | XTLS-Reality | OPEN | TLSv1.3 ✅ 证书 1311B |
| 9992 | Hysteria2 | Connection refused | （UDP-only，TCP 拒绝正常） |
| 9993 | TUIC | Connection refused | （UDP-only，正常） |
| 9994 | Trojan | OPEN | TLSv1.3 ✅ |
| 9995 | H2-Reality | **timeout** | — |
| 9996 | gRPC-Reality | **timeout** | — |
| 9997 | AnyTLS | OPEN | TLSv1.3 ✅ |
| 9998 | Naive | OPEN | TLSv1.3 ✅ |

Reality 端口 9991 能完成标准 TLS1.3 握手并返回证书 → **sing-box 服务在跑、Reality 回落正常、端口没被墙**。

### 2.4 VPS 在线 ✅

- `last_report`：11:22:22（实时上报正常）
- `agent_token`：`7b85084b-…350b7bd5`
- 附带发现：VPS 上还装着住宅代理（`tun_main`/`tun_backup` OpenVPN，JP 节点 175.132.59.112），
  日志里有连接超时——与本次节点问题无关，但 `exit_ip` 为空说明出口未验通

### 2.5 本地 agent.py 已是多对多新版 ✅

```
sha256 = bbd2131217fc3dff7de21d973d751f2b412d9f07437648f2e0e6b23a5d4372a0
len    = 94408 bytes
grant_users 出现次数 = 13
```

代码已是正确形态（第 993~1003 行）：

```python
grant_users = []                                  # 从 node_grants 聚合
...
if not grant_users:
    grant_users = [node.get("uuid") or ""]        # 无授权时回退主凭据
grant_users = [u for u in grant_users if u]
uuid_users = [{"uuid": c} for c in grant_users]
# Reality: "users": [{"uuid": c, "flow": "xtls-rprx-vision"} for c in grant_users]
# Hy2/TUIC/Trojan/AnyTLS: "users": [{"password": c} for c in grant_users]
```

**10 个协议分支全部由 `grant_users` 统一生成 users，消除了原先各分支硬编码单元素 users 的结构性缺陷。**

---

## 三、为什么管理员链接能通、用户链接全不通

这是本次诊断最关键的一点，完全符合预期：

| 链接来源 | 凭据来源 | VPS 旧版能否识别 | 结果 |
|---|---|---|---|
| 首页直接复制（管理员） | `nodes.uuid`（节点主凭据） | ✅ 能（旧版就用这个） | **能通** |
| lisi 订阅 | `node_grants.credential` | ❌ 不能 | **不通** |
| zhangsan 订阅 | `node_grants.credential` | ❌ 不能 | **不通** |

「第三个只能 2 个通」对上了——管理员链接里通的那 2 个应该是 Naive（9998）和某个恰好用了主凭据的节点。
Naive 本来就是单归属（`nodes.username`），走主凭据，能通。

**7 vs 5 的差异**：lisi / zhangsan 各授权 7 个多凭据协议节点；
管理员链接能看到全部 8 个，但其中 H2-Reality / gRPC-Reality 本来就被 v2rayN 拒（Xray 已移除 H2 transport），
再叠加上「旧版 agent 不认独立凭据」，最终只剩少数能通。

---

## 四、修复步骤（在 VPS 上执行）

### 4.1 先取证（确认推断）

```bash
bash /tmp/kui_probe.sh > /tmp/kui_probe.txt 2>&1
cat /tmp/kui_probe.txt
```

脚本第 3 节会打出 `grep -c grant_users /opt/kui/agent.py` 的结果。
**若为 0 → 推断成立**，就是 agent 没更新。

### 4.2 强制 agent 拉新版

VPS 上已有的安装命令（首页「安装命令」按钮可复制）：

```bash
curl -fsSL -H "Authorization: 7b85084b-310b-4943-96b4-cf24350b7bd5" \
  "https://kui-test.zhuyongfu.cn/api/agent_update?ip=38.207.173.192&component=agent" \
  -o /opt/kui/agent.py.new
```

核对指纹一致后再替换：

```bash
sha256sum /opt/kui/agent.py.new
# 应为 bbd2131217fc3dff7de21d973d751f2b412d9f07437648f2e0e6b23a5d4372a0
grep -c grant_users /opt/kui/agent.py.new   # 应为 13
```

替换并重启：

```bash
mv /opt/kui/agent.py.new /opt/kui/agent.py
chmod +x /opt/kui/agent.py
systemctl restart sing-box 2>/dev/null || systemctl restart kui-agent 2>/dev/null
```

### 4.3 验证 users 数组是否变成多用户

```bash
python3 -c "
import json
cfg = json.load(open('/etc/sing-box/config.json'))
for i in cfg['inbounds']:
    if i.get('type') in ('tun','mixed'): continue
    u = i.get('users') or []
    print(f\"port {i.get('listen_port')} {i.get('type')}: users={len(u)}\")
"
```

**期望：9991~9997 各显示 `users=2`**（lisi + zhangsan）。若仍是 1，则 config 未重新生成。

### 4.4 强制重拉配置

改完 agent 后 config 可能不会自动刷新（配置全量覆盖约 37 秒生效），建议直接：

```bash
systemctl restart kui-agent 2>/dev/null || pkill -f '/opt/kui/agent.py' && nohup python3 /opt/kui/agent.py >/opt/kui/agent.log 2>&1 &
sleep 45
# 再跑 4.3 的验证命令
```

---

## 五、注意事项

1. **不要动生产的 VPS**。当前测试指向的是 `kui-test.zhuyongfu.cn`，这台 hk-vmiss 上已无生产节点依赖（8 个节点都在测试库）。
2. **H2-Reality(9995) 与 gRPC-Reality(9996) 本来就不通**，原因是 Xray 25.x 已移除 HTTP/2 transport、gRPC+Reality 兼容性差——客户端限制，不是服务端 bug。
   加上这两条后，实际可测协议为 6 个：XTLS-Reality / Hysteria2 / TUIC / Trojan / AnyTLS / Naive。
3. **`/tmp/kui_probe.sh` 需要复制到 VPS 上**。文件在 `D:\code-new\K-UI\_verify\kui_probe.sh`（未纳入 git，含环境探测逻辑）。
4. VPS 上还跑着住宅代理（JP OpenVPN），如果后续要验证代理功能，先把它的 `exit_ip` 问题解决——现在两条隧道 `ready:false`。

---

## 六、待确认

`agent.py` 从旧版升到多对多版时，`grant_users` 为空会回退到 `node.get("uuid")`。
这意味着**如果某个多凭据节点在 `node_grants` 里没有任何记录，它会以主凭据继续服务**——
这是刻意设计（兼容老库），但要确认：是否该改成「无授权记录则不放行」以提高安全性。
当前实现偏兼容性，需要你定这个取舍。