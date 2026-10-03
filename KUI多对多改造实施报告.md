# 多对多改造实施报告

> 分支：`feat/multi-cred`　提交：`162d6ff`（改造）+ `cb4e76d`（测试环境配置）
> 线上生产环境：**零影响**（本次改动全部在独立分支，未部署）
> 时间：2026-10-04 03:00

---

## 一、问题本质

**vless 链接里的身份就是 UUID 本身。**

```
vless://<uuid>@host:port?security=reality&pbk=...&sid=...#备注
      ↑ 服务端唯一认的东西
```

服务端只有一个 inbound 的 `users` 数组，数组里有哪些 UUID 就放行哪些。**同一串链接 = 同一个 UUID = 服务端眼里的同一个人。**

所以旧模型 `nodes.username`（单值归属）有两个致命问题：

| 问题 | 表现 |
|---|---|
| 一条节点只能有一个 `username` | 无法表达「同一节点同时属于多个用户」|
| 多人拿同一串链接 | 服务端视为一人，停用/踢人时**全部一起断** |

**要推翻的假设**：「节点的链接 = 节点的身份」。
**正确模型**：**节点层（端口 + Reality 参数）≠ 凭据层（每人一个 uuid/password）**，两者必须解绑。

---

## 二、sing-box 能力实测结论（改造前提）

用本机 `sing-box 1.12.12`（取自 v2rayN 内置内核）在 `127.0.0.1` 上起隔离实例验证，**9 项全部通过**：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 同一 inbound 挂 2 个 UUID，同时连通 | 3/3 + 3/3 |
| 2 | 移除 B 后 A 不受影响 | 3/3 |
| 3 | B 重新加回可恢复 | 3/3 |
| 4 | **踢人即时生效（客户端不重启）** | B 从 3/3 → **0/3** |
| 5 | Reality 模式下挂多 UUID | `check` 通过 + 启动成功 |
| 6 | Hysteria2 挂多个 password | 通过 |
| 7 | TUIC 挂多组 uuid+password | 通过 |
| 8 | AnyTLS 挂多个 password | 通过 |
| 9 | Trojan 挂多个 password | 通过 |

### 两个关键发现

**① Reality 私钥无需按人生成**

`private_key` / `short_id` 是 **inbound 级共享参数**，与 `users` 数组**完全正交**。多人授权不需要为每人生成独立 Reality 密钥——这是多对多能低成本落地的关键。

**② 协议范围比预估更大**

原判断「Trojan / AnyTLS 的 password 复用 private_key，无法多对多」——**实测证明是错的**。users 数组每项可带独立 password。

---

## 三、改造内容

### 3.1 数据模型

```sql
CREATE TABLE IF NOT EXISTS node_grants (
  node_id    TEXT NOT NULL,
  username   TEXT NOT NULL,
  credential TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(node_id, username)
);
CREATE INDEX idx_node_grants_user ON node_grants(username);
CREATE INDEX idx_node_grants_node ON node_grants(node_id);
```

联合主键 `(node_id, username)` 保证「一个用户对一条节点只有一条凭据」；`nodes.uuid` 保留为主凭据，供降级与未授权场景使用。

### 3.2 协议能力判定（新增工具函数）

| 类型 | 协议 | 凭据落点 |
|---|---|---|
| uuid 型 | VLESS / XTLS-Reality / H2-Reality / gRPC-Reality / VLESS-Argo | `users[].uuid` |
| password 型 | Hysteria2 / Trojan / AnyTLS / TUIC | `users[].password`（TUIC 另需 uuid）|
| **保持单归属** | Naive / Socks5 | 不进授权表 |

### 3.3 渲染层 `functions/api/[[path]].js`

**上次全员断联的根因就在这里。** 10 个协议分支全部改用按人凭据：

```javascript
// 改前
case "XTLS-Reality": link = `vless://${node.uuid}@...`;
// 改后
case "XTLS-Reality": link = `vless://${cred}@...`;
```

| 改动点 | 位置 |
|---|---|
| 新增 `supportsMultiCredential` / `generateCredential` / `credentialFor` / `passwordFor` | 文件头 |
| 订阅查询并入 `node_grants` | 约 1490 行 |
| 渲染循环取出 `grantMap` → `cred` / `pass` | 约 1572 行 |
| **Base64 URL 分支 10 个协议**改用按人凭据 | 约 1588~1598 行 |
| **Clash YAML 分支 6 个协议**同步改 | 约 1603~1627 行 |
| 下发接口响应加 `node_grants` 并过滤停用用户 | 约 1361 行 |
| `/api/data` 挂 `_grant_users`（只含用户名，**不含凭据**） | 约 1927 行 |

### 3.4 下发层 `static/vps/agent.py`

**结构性缺陷修复**：此前 10 个分支各写一份单元素 users，没有统一聚合点。

```python
# 改前：每个分支各自硬编码
"users": [{"uuid": node["uuid"]}]                    # VLESS 系
"users": [{"password": node["private_key"]}]         # Trojan / AnyTLS

# 改后：唯一聚合入口
grant_users = [...]  # 无授权时回退 node["uuid"]
uuid_users = [{"uuid": c} for c in grant_users]
"users": [{"password": c} for c in grant_users]      # password 型
```

同时把下发数据里的 `node_grants` 按 `node_id` 挂回节点；老版 CF 不下发该字段时自动降级为单凭据模式。

### 3.5 授权接口语义变更

| 操作 | 旧行为 | 新行为 |
|---|---|---|
| 勾选节点 | `UPDATE nodes SET username=?`（整节点过户）| `INSERT` 一条 `node_grants` 记录 |
| 取消勾选 | 节点过户给管理员 | `DELETE` 该用户的凭据，**其他人不受影响** |
| 重复授权 | — | **保留原凭据不重新生成**（否则已发出的链接会失效）|

### 3.6 停用 / 删除的清理路径

| 操作 | 清理动作 | 受影响 VPS 收集来源 |
|---|---|---|
| 停用用户 | 下发时过滤（不删数据，可恢复）| `node_grants` ∪ `nodes.username` |
| 删除用户 | `DELETE FROM node_grants WHERE username=?` | 同上 |
| 删除节点 | `DELETE FROM node_grants WHERE node_id=?` | 节点自身 |
| 删除 VPS | 批量删除该 VPS 全部授权 | — |

⚠️ 受影响 IP 必须从**两处**收集，只查 `nodes.username` 会导致「用户已删但凭据还在放行」。

### 3.7 前端

| 改动 | 说明 |
|---|---|
| 删除「极速全量下发」的归属下拉框 | 节点层不再绑定用户 |
| 删除「手动单节点」的归属下拉框 | 同上 |
| 节点卡「👤 归属」改为「👥 N 人」 | 显示授权人数 |
| 授权页只列支持多凭据的协议 | `grantableNodes` computed |
| 下发确认文案 | 「节点建好后到用户授权页勾选即可分配」 |

---

## 四、部署前自检（防第三次翻车）

`_verify/consistency_check.py`：**62 项全部通过**。

覆盖范围：

| 章节 | 检查内容 |
|---|---|
| 1. schema | 表存在、联合主键、两个索引 |
| 2. URL 分支 | 10 个协议逐个确认用 `cred`/`pass` 且不直读 `node.uuid` |
| 3. Clash 分支 | 6 类代理确认同步改用按人凭据 |
| 4. 下发接口 | 含 `node_grants`、过滤停用用户、按 node_id 分组 |
| 5. agent 聚合 | 聚合逻辑存在、无硬编码单元素 users、8 个分支逐一确认 |
| 6. 前端 | 协议过滤、两处下拉框已删、人数显示 |
| 7. 清理路径 | 4 条删除路径都清理 `node_grants` |
| 8. 授权语义 | 走 `node_grants`、保留已有凭据、协议白名单 |
| 9. **真实内核校验** | 用本机 sing-box 1.12.12 `check` 校验 8 个协议的 **2-user** 配置 |

第 9 项是核心——它把「聚合出来的 users 数组」直接喂给真实内核，确认配置合法。

### 自检脚本的调试教训

初版对 Hysteria2 误报失败。原因：

```python
# 错：${encodeURIComponent(cred || node.private_key)} 内部的 } 让 [^}]* 提前截断
re.search(r'\$\{cred(?:\s*\|\|[^}]*)?\}', line)
# 对：直接判断是否引用了凭据变量
re.search(r'\bcred\b', line)
```

**教训：自检脚本必须先自证不会误报**，否则会掩盖真 bug 或制造假警报。

---

## 五、测试环境状态

| 项 | 状态 |
|---|---|
| 配置 | `wrangler.test.jsonc`（name `kui-test`，无 cron，独立 D1）|
| D1 数据库 | ✅ 已建 `kui-test-db` / `ee9b5fe5-9023-4720-b2f5-bd2c3db12937` |
| Worker 部署 | ⏸️ **卡在 token 缺 Workers Scripts:Edit 权限** |
| 本地打包 | ✅ 通过（197.66 KiB，绑定全对）|

### 权限矩阵实测

现有 `cfut_` token：✅ `zones` / `workers/scripts` / `workers/subdomain`　❌ `d1/database`
新给 `cfat_` token：✅ `d1/database/{id}`　❌ `workers/scripts/*`、`workers/subdomain`、`workers/domains/records`

**两个 token 各缺一半权限，需要合并或新建。**

### 需要的权限

| 权限 | 用途 |
|---|---|
| Account → Workers Scripts: Edit | 部署 Worker |
| Account → D1: Edit | 迁移与查库 |
| Zone → Workers Routes: Edit | 绑 `kui-test.zhuyongfu.cn`（可选）|

---

## 六、下一步

1. 取得有 Workers Scripts:Edit 的 token
2. 部署 `kui-test` → 初始化管理员 → 建假 VPS 数据
3. **核心验证**：比对「测试环境订阅里的凭据」与「下发给 VPS 的 users 数组」是否逐一对应
4. 一致才允许部署生产；不一致则回滚重查

---

## 七、回滚

| 动作 | 命令 |
|---|---|
| 代码回滚 | `git checkout main`（生产仍在 `355a640`）|
| CF 版本回滚 | `npx wrangler rollback 1573bac5-b620...`（用 `npx wrangler versions list` 确认完整 ID）|
| 注意 | `wrangler rollback` **只回滚代码不回滚 D1**，`node_grants` 表会残留但当前代码不读|
