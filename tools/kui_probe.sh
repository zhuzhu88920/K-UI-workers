#!/bin/bash
# K-UI VPS 侧取证脚本 —— 在 VPS 上以 root 执行
# 用法：bash /tmp/kui_probe.sh > /tmp/kui_probe.txt 2>&1
# 然后把 /tmp/kui_probe.txt 内容贴回来

echo "===== 1. sing-box 进程与版本 ====="
ps aux | grep -E "sing-box|singbox" | grep -v grep
sing-box version 2>/dev/null || /usr/local/bin/sing-box version 2>/dev/null || echo "(sing-box 不在 PATH)"

echo
echo "===== 2. sing-box systemd 状态 ====="
systemctl is-active sing-box 2>/dev/null && systemctl status sing-box --no-pager -l 2>/dev/null | head -20
systemctl list-units --type=service --all 2>/dev/null | grep -iE "sing|kui"

echo
echo "===== 3. K-UI agent 状态与版本 ====="
ls -la /opt/kui/ 2>/dev/null
echo "--- .update-pending ---"
cat /opt/kui/.update-pending 2>/dev/null || echo "(无)"
echo "--- .quarantined-versions ---"
cat /opt/kui/.quarantined-versions 2>/dev/null || echo "(无)"
echo "--- agent.py 是否有 grant_users（多对多关键） ---"
grep -c "grant_users" /opt/kui/agent.py 2>/dev/null || echo "0  <<< 若为 0，agent 还是旧版！"
grep -n "node_grants" /opt/kui/agent.py 2>/dev/null | head -5

echo
echo "===== 4. sing-box 实际配置位置 ====="
for p in /etc/sing-box/config.json /usr/local/etc/sing-box/config.json /opt/kui/config.json /etc/sing-box.json; do
  if [ -f "$p" ]; then echo "FOUND: $p  ($(wc -c <"$p") bytes, mtime $(date -r "$p" 2>/dev/null))"; fi
done

echo
echo "===== 5. inbound 监听端口与 users 数组（最关键） ====="
CFG=""
for p in /etc/sing-box/config.json /usr/local/etc/sing-box/config.json /opt/kui/config.json /etc/sing-box.json; do
  [ -f "$p" ] && CFG="$p" && break
done
if [ -n "$CFG" ]; then
  echo "读取: $CFG"
  python3 - "$CFG" <<'PYEOF'
import json, sys
cfg = json.load(open(sys.argv[1]))
ins = [i for i in cfg.get('inbounds', []) if i.get('type') != 'tun' and i.get('type') != 'mixed']
print(f"inbounds 总数: {len(cfg.get('inbounds', []))}  (排除tun/mixed 后 {len(ins)})")
print()
multi = 0
for i in ins:
    users = i.get('users') or []
    tag = i.get('tag', '?')
    lst = i.get('listen_port') or i.get('listen')
    typ = i.get('type')
    print(f"[{tag}] type={typ} port={lst} users={len(users)}")
    for u in users:
        # 只打印凭据前缀，避免刷屏
        cred = u.get('uuid') or u.get('password') or '?'
        print(f"     uuid/password = {cred}")
    if len(users) > 1:
        multi += 1
    print()
print(f">>> 多凭据 inbound 数量: {multi}  ({'正常，agent 已是多对多新版' if multi > 0 else '异常！inbound 只有单用户 = VPS 跑的还是旧配置'})")
print()
print("--- outbound 数 ---", len(cfg.get('outbounds', [])))
PYEOF
else
  echo "!! 没找到配置文件"
fi

echo
echo "===== 6. 端口实际监听情况 ====="
ss -tlnp 2>/dev/null | grep -E ":999[0-9]" || netstat -tlnp 2>/dev/null | grep -E ":999[0-9]" || echo "(9991-9998 无监听)"

echo
echo "===== 7. sing-box 配置校验 ====="
CFGV=""
for p in /etc/sing-box/config.json /usr/local/etc/sing-box/config.json /opt/kui/config.json; do
  if [ -f "$p" ]; then CFGV="$p"; break; fi
done
if [ -n "$CFGV" ]; then
  sing-box check -c "$CFGV" 2>&1 | head -30 || /usr/local/bin/sing-box check -c "$CFGV" 2>&1 | head -30
fi

echo
echo "===== 8. sing-box 最近日志（认证失败线索） ====="
journalctl -u sing-box --no-pager -n 60 2>/dev/null | tail -60

echo
echo "===== 9. agent 日志 ====="
ls /opt/kui/*.log /var/log/kui* 2>/dev/null
for f in /opt/kui/agent.log /var/log/kui/agent.log; do
  [ -f "$f" ] && echo "--- $f (末 50 行) ---" && tail -50 "$f"
done

echo
echo "===== 10. 防火墙（端口是否被 DROP） ====="
iptables -L KUI-BLOCK -n 2>/dev/null || echo "(无 KUI-BLOCK 链 = 正常)"
iptables -S 2>/dev/null | grep -E "999[0-9]" || echo "(INPUT 链无 9991-9998 相关规则)"

echo
echo "===== 11. agent 拉取到的 CF 配置（缓存文件） ====="
find /opt/kui -name "*.json" -o -name "*.cache" 2>/dev/null | head -20
for f in /opt/kui/.config_cache.json /opt/kui/.last_config; do
  [ -f "$f" ] && echo "--- $f ---" && head -c 1500 "$f" && echo
done

echo
echo "===== DONE ====="