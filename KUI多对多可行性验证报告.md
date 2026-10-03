# 阶段 3 验证报告：sing-box 多 UUID / 多凭据可行性

> 时间：2026-10-04 02:45
> 环境：本机 Windows，sing-box **1.12.12**（取自 `C:\GreenSoft\v2rayN-windows-64-SelfContained\bin\sing_box\sing-box.exe`）
> 隔离性：全部监听 `127.0.0.1`，端口 20001~20213，**不碰任何现有配置、不需root、无线上影响**
> 脚本：`_verify/verify_multi_uuid.py`、`_verify/verify_extra.py`

---

## 一、结论速览

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 同一 inbound挂 2 个 UUID，两个客户端**同时**连通 | ✅ 3/3 + 3/3 |
| 2 | 移除 UUID_B 后，**A 完全不受影响** | ✅ 3/3 |
| 3 | 把UUID_B 加回，B 恢复可用 | ✅ 3/3 |
| 4 | **踢人即时生效**（客户端 B 不重启，服务端一改就断） | ✅ B 从 3/3 → **0/3** |
| 5 | **Reality 模式**下挂多 UUID | ✅ `check` 通过 + 启动成功 |
| 6 | Hysteria2 挂多个 `password` | ✅ 通过 |
| 7 | TUIC 挂多组 `uuid` + `password` | ✅ 通过 |
| 8 | **AnyTLS 挂多个 `password`** | ✅ 通过（意外收获）|
| 9 | **Trojan 挂多个 `password`** | ✅ 通过（意外收获）|

**总体结论：多对多技术方案完全可行。** 上次全员断联**不是sing-box 不支持**，而是 K-UI 渲染层与agent 层没有贯通凭据。

---

## 二、关键证据

### 阶段 1~3：多 UUID 基础可行性

```
[阶段1] UUID_A 成功 3/3
[阶段1] UUID_B 成功 3/3        ← 两个 UUID 同时可用
[阶段2] UUID_A 在 B 被移除后 成功 3/3   ← A 不受牵连
[阶段3] UUID_B 重新授权后 成功 3/3     ← 可恢复
```

### 补充验证 A：踢人是否即时生效（最关键的一项）

这一项模拟的是 K-UI 真实踢人路径——**客户端不会重启，只有服务端改配置**：

```
[A] 移除前: A=3/3  B=3/3
[A] 移除后: A=3/3  B=0/3  (B 客户端全程未重启)
[A] 结论: ✅ 踢人即时生效，且不牵连 A
```

`B=0/3` 说明：**只要 sing-box 重载了配置，被移除的 UUID 立刻失效**，不需要动客户端。这正是"识别并踢出共享用户"要的效果。

### 补充验证 B：Reality 模式（生产实际用的模式）

```
[B] Reality 多 UUID 配置校验: 通过
[B] Reality inbound 启动成功（多 UUID 被 sing-box 接受）
```

Reality 的 `private_key` / `short_id` 属于 **inbound 级共享参数**，与 `users` 数组正交。因此挂多人**不需要为每个人单独生成 Reality 密钥**——这是多对多能低成本落地的关键。

### 补充验证 C：其他协议的多凭据

初次测试报 `TLS required`，是我测试配置缺 `tls` 段（这两个协议强制要求 TLS），**不是多凭据不支持**。补上自签证书后复测：

| 协议 | 多凭据写法 | 结果 |
|---|---|---|
| Hysteria2 | `users: [{password: A}, {password: B}]` | ✅ 通过 |
| TUIC | `users: [{uuid, password}, {uuid, password}]` | ✅ 通过 |
| **AnyTLS** | `users: [{password: A}, {password: B}]` | ✅ 通过 |
| **Trojan** | `users: [{password: A}, {password: B}]` | ✅ 通过 |

---

## 三、对 K-UI 改造方案的影响

### 3.1 协议范围可以扩大

原计划只开放 4 个协议（因推测 Trojan/AnyTLS 的 `password` 复用 `private_key` 无法按人区分）。**实测证明这个顾虑不成立**——sing-box 的 `users` 是数组，每个元素可以带独立 `password`，与 inbound 级的 `tls`/Reality 参数无关。

因此 Trojan / AnyTLS **也可以开放多对多**，只需为每个用户生成独立 password（而非复用 `node.private_key`）。

### 3.2 必须修改的两处（上次翻车的真凶）

| 层 | 文件:行 | 现状 | 必须改为 |
|---|---|---|---|
| **渲染层** | `functions/api/[[path]].js:1505-1515` | 全部读 `node.uuid`（单值） | 按 `username` 从凭据表取该人的 uuid/password |
| **下发层** | `static/vps/agent.py:963-973` | 10 个分支各自硬编码 `"users": [{...}]` 单元素 | **统一聚合**：按凭据表查出该节点所有授权用户，生成 users 数组 |

`agent.py` 现状（节选）：

```python
if proto == "VLESS":
    singbox_config["inbounds"].append({..., "users": [{"uuid": node["uuid"]}]})
elif proto in ["XTLS-Reality", "Reality"]:
    singbox_config["inbounds"].append({..., "users": [{"uuid": node["uuid"], "flow": "xtls-rprx-vision"}], ...})
elif proto == "Trojan":
    singbox_config["inbounds"].append({..., "users": [{"password": node["private_key"]}]})   # ← 复用私钥
...
```

**每个分支各写一份单元素 users，没有统一聚合点**——这是结构性缺陷。

### 3.3 上次全员断联的完整因果链

```
① 加了node_grants 表，每人一条独立 UUID
② 但渲染层没改→ 订阅链接里仍是 node.uuid（节点主 UUID）
③ agent.py 没改       → VPS users 数组里也是 node.uuid
④ 两者恰好相同本应能通，但一旦部分渲染改成读 grant 就会全错
   → 表现为「所有节点全断」（订阅是统一渲染的，链接全错必然全断）
```

**这就是为什么必须先验 CF 侧数据一致性**： sing-box 侧已经完全确认没问题，剩下的问题纯在 K-UI 代码。

---

## 四、待验证（进入阶段 4）

sing-box 能力已全部确认，但**仍未验证 K-UI 改造后的数据一致性**。需在 CF 测试环境比对：

```bash
# 测试环境订阅（用户 A）
curl -s "https://<测试域名>/api/sub?user=A&token=..." | base64 -d | grep -o 'vless://[^@]*'

# 测试环境下发给 VPS 的配置
curl -s -H "Authorization: Bearer <agent_token>" "https://<测试域名>/api/...config?ip=..." \
  | python -c "import json,sys;d=json.load(sys.stdin);[print(i['listen_port'],[u for u in i.get('users',[])]) for i in d.get('inbounds',[]) if i.get('users')]"
```

**两边凭据必须逐一对应**，一致后才允许进入线上部署。

---

## 五、复现方式

```powershell
cd D:\code-new\K-UI\_verify
python verify_multi_uuid.py    # 阶段 1-3：多 UUID 可行性 + 精准踢人
python verify_extra.py         # 补充：A 即时踢人 / B Reality / C 多凭据
```

生成的证据文件：
- `verify_result.json` / `verify_log.txt`
- `verify_result2.json` / `verify_log2.txt`

---

## 六、教训

1. **不要在测试配置里省略必填段就断言"功能不支持"**。Hysteria2/TUIC 报 `TLS required` 被我一度误读为"不支持多凭据"，实际补上 `tls` 后全部通过。
2. **验证要覆盖"客户端不重启"这个真实约束**。K-UI 踢人时不可能要求用户重启客户端，所以补充验证 A 才是最有说服力的一项。
3. **协议能力要查文档 + 实测双保险**。本次 AnyTLS/Trojan 多凭据能力就是靠实测才发现的，之前的推测是错的。
