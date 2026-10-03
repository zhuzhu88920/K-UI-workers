# K-UI 节点协议问题存档

> 记录时间：2026-10-04
> 涉及版本：`1573bac5`
> 状态：**暂不处理，留待后续**（用户决策：先专注多对多用户-节点管理）

---

## 一、问题概述

用户反馈：v2rayN 更新订阅后只显示 11 条记录，其中 4 条不通，怀疑"导入失败"。

实测结论：**没有任何一条是导入失败丢掉的**。真实情况是客户端内核能力差异 + 协议组合本身不存在。

---

## 二、数字对账（实测）

### 订阅实际输出：18 条

```bash
curl -s "https://kui.zhuyongfu.cn/api/sub?user=zhuzhu&token=<TOKEN>" | base64 -d
```

| 协议 | 条数 |
|---|---|
| vless | 6（XTLS-Reality / H2-Reality / gRPC-Reality × 2 台 VPS）|
| anytls | 2 |
| naive | 2 |
| hysteria2 | 2 |
| trojan | 2 |
| tuic | 2 |
| socks5 | 2（住友 SOCKS5 第三方转发，非自建）|

> 历史记录里曾说"16 条"，是漏算了2 条 socks5，实际 **18 条**。

### v2rayN 数据库实际落库

数据库位置：`C:\GreenSoft\v2rayN-windows-64-SelfContained\guiConfigs\guiNDB.db`
表：`ProfileItem`，共 42 条，分属 3 个订阅组。

| Subid | 备注 | 节点数 | 订阅 URL 域名 |
|---|---|---|---|
| `5731329094966451974` | kui | **20** | `kui.z8j.cc.cd`（旧版 K-UI）|
| `5470372906809395693` | kui-zhu | **11** | `kui.zhuyongfu.cn`（新版）|
| `5466623216519001036` | test | 11 | `kui.zhuyongfu.cn`（用户 zhu）|

**用户看到的"11 条"= `kui-zhu` 组**。用户更新的是 `kui.z8j.cc.cd` 那条旧版链接，库里 `kui` 组实际有 20 条（含 jp-bytevirt 第三台 VPS）。

### ConfigType 枚举分布（全库）

| ConfigType | 数量 | 对应协议 |
|---|---|---|
| 5 | 21 | VLESS |
| 6 | 5 | Trojan |
| 7 | 7 | Hysteria2 |
| 8 | 6 | TUIC |
| 11 | 3 | AnyTLS |
| — | **0** | **Naive（完全缺失）** |

---

## 三、四个具体问题

### 问题 1：AnyTLS 其实导入了（此前的判断有误）

**曾误判**："AnyTLS/Naive 压根就没有，虽然前台显示是有的"。

**实测结论**：AnyTLS **完整入库**，`ConfigType=11`，三条记录备注均带 `AnyTLS_9997`，凭据与 VPS `/etc/sing-box/config.json` 逐条对得上：

```
VPS 实测: port=9997 anytls password = '***REDACTED-ANYTLS-PASSWORD***'
订阅输出: anytls://***REDACTED-ANYTLS-PASSWORD***@38.207.173.192:9997
```

走 sing-box 内核（`core=24`）。**AnyTLS 无任何问题。**

### 问题 2：Naive 全部丢失（真问题）

- 订阅输出 `naive+https://` scheme × 2 条
- v2rayN 数据库里 **0 条 naive**
- 根因：**v2rayN 订阅解析器不认 `naive+https://` 这个 scheme**，与服务端无关

### 问题 3：H2-Reality / gRPC-Reality 在 Xray 内核下必然失败（真问题）

**这是"4 条不通"的真身**。日志证据：

```
2026-10-04 02:13:35 CoreHandler 运行 Core 失败，请查看提示信息
2026-10-04 02:13:41 CoreHandler 运行 Core 失败，请查看提示信息
2026-10-04 02:13:59 CoreHandler 运行 Core 失败，请查看提示信息
2026-10-04 02:14:02 CoreHandler 运行 Core 失败，请查看提示信息
```

间隔 3~6 秒，是用户手动逐条测速时触发核心启动失败。

#### 实测验证（使用用户本机真实内核）

内核路径：`C:\GreenSoft\v2rayN-windows-64-SelfContained\bin\`
- Xray **25.10.15**（b69a376, go1.25.3）
- sing-box **1.12.12**

| 组合 | Xray 25.10.15 | sing-box 1.12.12 |
|---|---|---|
| vless + Reality + `type=http`（H2） | ❌ 拒绝启动 | ✅ check EXIT=0 |
| vless + Reality + `grpc`（gRPC） | — | ✅ check EXIT=0 |
| vless + `xhttp` | ✅ Configuration OK | — |

**Xray 25.10.15 原文报错**：

```
Failed to start: main: failed to load config files: [h2.json] >
infra/conf: failed to build inbound config with tag h2in >
common/errors: The feature HTTP transport (without header padding, etc.)
has been removed and migrated to XHTTP stream-one H2 & H3.
Please update your config(s) according to release note and documentation.
```

**结论**：H2 传输层已被 Xray 官方**硬删除**，迁移到 XHTTP。不是配置写错，不是服务端问题。
`Reality + gRPC` 在 sing-box 内核下有效，但 Xray 内核不支持该组合。

#### 重要概念澄清

**v2rayN 与 sing-box 不是同一层级的竞品**：

| 名称 | 层级 | 说明 |
|---|---|---|
| **v2rayN** | Windows 客户端 GUI | 用户正在使用的界面 |
| **sing-box** | 内核（无界面） | **v2rayN 已内置**（`bin/sing_box/sing-box.exe`）|
| Hiddify / SFA / FlClash | sing-box / mihomo 的第三方 GUI | 换这些才是"换客户端" |

用户库里`core=24` 的记录（Hysteria2 / TUIC / AnyTLS）**本来就是 sing-box 内核在跑**，早就在用sing-box 了。

**问题本质是：v2rayN 给某个节点选了哪个内核，而非是否使用 sing-box。**

### 问题 4：订阅输出 18 条但用户实际可用 11 条 —— 缺口明细

以 `kui-zhu` 组（11 条）为基准：

| VPS | 入库 | 应有 | 缺口 |
|---|---|---|---|
| hk-vmiss | XTLS, Hysteria2, TUIC, Trojan, H2, gRPC, AnyTLS = 7 | 9 | Naive、SOCKS5 |
| us-racknerd | XTLS, Hysteria2, Trojan, H2, gRPC, AnyTLS = 6 | 9 | **TUIC 也缺**、Naive、SOCKS5 |
| jp-bytevirt | 7 | 9 | Naive、SOCKS5 |

**缺口性质**：
- Naive × N → v2rayN 解析器不支持 scheme
- SOCKS5 × N → 第三方转发节点，且端口 7920 是 K-UI agent 预留给 proxy-lite 的
- us-racknerd TUIC 缺失 → 待查（可能节点本身未下发成功）

---

## 四、库中遗留问题

**3 个订阅组共存**，其中 2 条指向已废弃的旧版域名 `kui.z8j.cc.cd`：
- 旧组更新会与新组节点混淆
- `SubItem.UpdateTime` 全部为 NULL，无法从元数据判断最后更新时间
- `SubItem.Filter` 全部为空字符串，未配置过滤规则

**建议**（未执行）：清理旧组，只保留 `kui.zhuyongfu.cn`。

---

## 五、候选处置方案（留待后续决策）

| 方案 | 内容 | 代价 |
|---|---|---|
| A | 从下发列表移除 H2/gRPC（推荐）| 11 条干净列表，永久放弃 2 条 |
| B | 保留 + 标注"仅 sing-box 内核客户端可用" | 列表不变，但v2rayN 用户每次测速都失败 |
| C | 改渲染逻辑，修Naive / socks5 输出 | 需确认客户端支持情况 |
| D | 装 Hiddify Next，用 `?format=clash` 导入专门跑 H2/gRPC | 换客户端，v2rayN 仍作主力 |

### 备选客户端下载链接（若走方案 D）

| 客户端 | 说明 | 地址 |
|---|---|---|
| Hiddify Next | 界面干净，自动优选 | https://github.com/hiddify/hiddify-next/releases |
| FlClash | 活跃的 Clash 系（mihomo 内核）| https://github.com/chen08209/FlClash/releases |
| sing-box-for-android (SFA) | 官方 Android GUI | https://github.com/SagerNet/sing-box-for-android |
| Clash Verge Rev | Windows 原生 Clash GUI | https://github.com/clash-verge-rev/clash-verge-rev/releases |

> 导入需Clash 格式订阅：K-UI 订阅 URL 加 `&format=clash`

---

## 六、复现命令

```powershell
# 1. 读取 v2rayN 节点库（只读，务必先复制再读）
Copy-Item "C:\GreenSoft\v2rayN-windows-64-SelfContained\guiConfigs\guiNDB.db" "$env:TEMP\v2rayn.db"
python -c "import sqlite3;c=sqlite3.connect(r'$env:TEMP\v2rayn.db');c.row_factory=sqlite3.Row;[print(d['ConfigType'],d['Port'],d['Remarks'],d['CoreType']) for d in c.execute('select ConfigType,Port,Remarks,CoreType from ProfileItem')]"

# 2. 查内核版本
& "C:\GreenSoft\v2rayN-windows-64-SelfContained\bin\xray\xray.exe" version
& "C:\GreenSoft\v2rayN-windows-64-SelfContained\bin\sing_box\sing-box.exe" version

# 3. 验证 Xray 是否支持某传输层（写临时 json 后 run -test）
& "...\bin\xray\xray.exe" run -test -c h2.json

# 4. 验证 sing-box 是否支持
& "...\bin\sing_box\sing-box.exe" check -c sb_h2.json
```

> ⚠️ 测Reality 配置必须用**合法私钥**，否则报`illegal base64 data` / `empty "password"`，容易被误判为"不支持"。

---

## 七、教训

1. **区分噪音与真错**：`contentscript.js` MaxListeners warning、MetaMask `ObjectMultiplex` orphaned data、`cdn.tailwindcss.com should not be used in production` 全是扩展/官方提示，与项目无关。
2. **不要用"配置校验失败"推断"功能不支持"**：Xray 报 `empty "password"` 时先检查自己的输入是否合法。
3. **数字要对账**：说"16 条"之前先 `grep -c '://'` 数一遍，说"导入失败"之前先读目标数据库。
