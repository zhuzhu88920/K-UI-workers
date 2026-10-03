# KUI 多对多授权 —— Cloudflare 测试环境验证报告

- 日期：2026-10-04
- 分支：`feat/multi-cred`（生产 `main` 未动）
- 测试 Worker：`kui-test` → https://kui-test.zhuyongfu.cn
- 测试 D1：`kui-test-db`（`ee9b5fe5-9023-4720-b2f5-bd2c3db12937`），与生产 `kui-v2-db` 完全隔离
- 部署版本：`20c4cd09-4ba9-49f7-bb9c-77a23f9d7286`
- 验证脚本：`_verify/e2e_multi_cred.mjs`

---

## 一、结论

**37 项端到端断言全部通过。** 多对多用户—节点授权在真实 Cloudflare Workers + D1 环境下行为正确，
未出现上一版「全员断联」的症状。生产环境未做任何改动。

---

## 二、测试场景

| 项 | 值 |
|---|---|
| VPS | `10.99.168.1`（虚构记录，不指向任何真实主机） |
| 节点 | 4 个：`XTLS-Reality:31001` / `Hysteria2:31002` / `TUIC:31003` / `Trojan:31004` |
| 用户 | `alice_*`（授权 4 个节点）、`bob_*`（授权 2 个节点） |

「bob 与 alice 共享 2 个节点」是本轮的核心场景——这在旧的 `nodes.username` 单归属模型下无法表达。

---

## 三、验证矩阵

### 3.1 基础设施

| 断言 | 结果 |
|---|---|
| 全新库 `/api/setup` 返回未初始化 | PASS |
| 初始化管理员成功并签发会话 | PASS |
| 重复初始化被拒（409，数据库主键保证） | PASS |
| 管理员登录 | PASS |
| VPS 记录新增 | PASS |
| 4 种协议节点创建 | PASS（4/4） |

### 3.2 多对多授权（核心）

| 断言 | 结果 |
|---|---|
| alice 授权 4 个节点（`granted:4`） | PASS |
| bob 授权 2 个节点（`granted:2`） | PASS |
| alice 订阅返回 **4** 条 | PASS |
| bob 订阅返回 **2** 条 | PASS |
| 两用户共享端口的节点数 = **2** | PASS |
| 同节点两用户凭据**互不相同**（相同 0 处） | PASS |

凭据样本（同一 Reality 节点 31001）：

| 用户 | 凭据 |
|---|---|
| alice | `a80146bc-5685-4b50-ba62-2e227d3726ae` |
| bob | `78bbaced-df01-4e63-8086-555af9d4dc3f` |

同节点（31002 Hysteria2，password 型）：

| 用户 | 凭据 |
|---|---|
| alice | `kKzre9JEOApjJa+S06XapQ==` |
| bob | `JlgQ0mBTwZzsq/qGfQErPw==` |

### 3.3 凭据隔离（上次全员断联的根因点）

| 断言 | 结果 |
|---|---|
| Base64 订阅渲染按人取凭据 | PASS |
| Clash YAML 渲染按人取凭据 | PASS |
| 两人订阅中共有节点的 uuid 交集 = 0 | PASS |
| **`/api/config` 下发的 credential 与各用户订阅逐条一致** | **PASS（不一致 0 处）** |

最后一条是上一版翻车的直接位置：VPS `config.json` 里的 `users[]` 与订阅链接用的凭据若不一致，
sing-box 就只认其中一套，另一套全员握手失败。本轮逐节点逐用户比对，无一处不一致。

VPS 配置接口实际下发的共享情况：

```
n-hy2-musseyra    → ["alice_musseyra", "bob_musseyra"]
n-reality-musseyra → ["alice_musseyra", "bob_musseyra"]
```

### 3.4 撤销 / 恢复 / 停用

| 断言 | 结果 |
|---|---|
| bob 撤销 1 个节点 | PASS |
| alice 不受影响，仍 4 条 | PASS |
| bob 降为 1 条 | PASS |
| bob 重新授权后恢复 2 条 | PASS |
| **重新授权时原凭据未被更换**（旧链接仍有效） | PASS（`JlgQ0mBTwZzsq/qGfQErPw==` 前后一致） |
| 停用后真实节点降为 0（仅剩提示假节点） | PASS |
| 重新启用后订阅恢复 2 条 | PASS |

停用时服务端按 3x-ui 的做法返回 200 + 一条写明原因的假节点，而不是 404，
用户能在客户端里看到「✖ bob | 已被管理员停用」而不是误以为订阅坏了：

```
socks5://a3VpLWJvbG9ja2VkOjA==@127.0.0.1:1#✖bob_xxx | 已被管理员停用
```

### 3.5 权限与清理

| 断言 | 结果 |
|---|---|
| 管理员可取到 `agent_token` | PASS |
| VPS Agent 认证拉取 `/api/config` | PASS |
| 订阅 token 不能当会话 token 用（401） | PASS |
| 删除用户后订阅 404 | PASS |
| 删除用户后 `node_grants` 记录清空 | PASS（残留 0） |

---

## 四、多凭据协议白名单（前后端一致）

| 类型 | 协议 | 凭据字段 |
|---|---|---|
| uuid 型 | VLESS / XTLS-Reality / Reality / H2-Reality / gRPC-Reality / VLESS-Argo | `users[].uuid` |
| password 型 | Hysteria2 / TUIC / Trojan / AnyTLS | `users[].password`（TUIC 另需 uuid） |
| 不开放 | Naive / Socks5 | 双字段且涉及转发语义，超出本次范围 |

前端 `static/index.html` 与后端 `MULTI_CRED_PROTOCOLS` 白名单逐项一致（10 个协议）。
授权页只列出这些节点；节点页已无「归属权 / 仅下发」用户选择。

---

## 五、本轮修的问题

**均为测试脚本自身缺陷，非产品代码缺陷：**

1. 订阅参数名写错 —— 实际契约是 `?user=X&token=Y`（`token` 单参会 404）
2. 授权接口走错 —— 实际是 `PATCH /api/users` 带 `{username, nodes[]}` body，不是 `PATCH /api/user?username=`
3. 订阅返回 base64 包装，解码器未处理
4. `config` 接口需用 `agent_token` 而非会话 token
5. 停用判定未过滤「提示假节点」
6. 清理 D1 时漏 DROP `login_throttles`，导致残留外键使 `ensureDbSchema` 循环抛 1101

**产品代码本轮零改动。**

---

## 六、遗留事项（未在上线范围内）

1. **协议兼容问题依旧挂账**：H2/gRPC 在 Xray 25.x 已被移除 transport 配置，v2rayN 侧不可用；
   Naive scheme 不被识别。这些属客户端兼容，与多对多无关，详见 `KUI节点协议问题存档.md`。
2. **本轮只验到 CF 侧**。sing-box 本机多凭据连通性此前已验过（9 协议全通，含客户端不重启即热踢），
   但「真实 VPS 上 agent 拉取多用户配置 → sing-box 实际放行两套凭据 → 撤销后立即失效」
   这条完整链路尚未在测试 VPS 上跑过。上线前建议用独立 VPS 先验这一段。
3. 测试库 D1 目前留有本轮测试数据（1 VPS / 4 节点 / 1 管理员 / 若干用户），可随时清空。

---

## 七、上线前检查清单

- [ ] 在独立测试 VPS 上跑通 agent 全链路（拉配置 → 双凭据握手 → 撤销即断）
- [ ] 确认授权页是否要收敛到用户指定的 4 个协议（当前 10 个）
- [ ] 生产 D1 需执行 `ensureDbSchema` 自动建 `node_grants` 表（代码已含 `CREATE TABLE IF NOT EXISTS`，无需手写迁移）
- [ ] 生产老数据兼容：`nodes.username` 保留为回退路径，不删列
- [ ] 回滚基线仍可用：`safe-115c7d33` tag / `_baseline/115c7d33/`