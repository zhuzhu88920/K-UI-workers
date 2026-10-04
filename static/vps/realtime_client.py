import json
import os
import random
import socket
import ssl
import threading
import time
import uuid
import urllib.parse

try:
    import websocket
except ImportError:
    websocket = None


def _ipv4_only():
    """让 socket 解析只用 IPv4。

    这台 VPS 的 IPv6 出口对 Cloudflare 域名不通（`No route to host`），
    IPv4 秒通。websocket-client 走 `socket.create_connection`，会按
    getaddrinfo 的返回顺序逐个尝试且不会快速失败，IPv6 排前面时握手必然
    超时 —— 表现是 realtime 通道静默失效、「配置变更要等 30~300s 才生效」。

    ⚠️ 这里必须**过滤**而不是重排：重排无效，因为 create_connection 拿到
    列表后自己再挑/再连，IPv4 只是被排到后面，仍会被先试。
    实测对照（同一台 VPS，同一 URL）：
        原始            FAIL 3.9s  [Errno 113] No route to host
        过滤成 IPv4-only  OK   1.0s
    """
    real = socket.getaddrinfo

    def ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        try:
            infos = real(host, port, family, type, proto, flags)
        except Exception:
            # 目标真的只有 IPv6 时不要把连接彻底断掉，退回系统默认行为
            return real(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        v4 = [i for i in infos if i[0] == socket.AF_INET]
        return v4 or infos

    socket.getaddrinfo = ipv4_only
    return real


def _prefer_reachable_family(base_url):
    """按 URL scheme 决定是否启用 IPv4-only 解析。

    保留开关是为了不在别的机器上意外改变行为：默认走 IPv4-only（Cloudflare
    域名在绝大多数机器上双栈可用，强制 IPv4 无害），设 KUI_REALTIME_ALLOW_IPV6=1
    可恢复系统默认解析。
    """
    if os.environ.get("KUI_REALTIME_ALLOW_IPV6", "").strip() in {"1", "true", "yes"}:
        return None
    return _ipv4_only()


class RealtimeChannel:
    def __init__(self, base_url, ip, token, role, on_message=None):
        self.base_url = (base_url or "").rstrip("/")
        self.ip = ip
        self.token = token
        self.role = role
        self.on_message = on_message
        self.boot_id = str(uuid.uuid4())
        self.seq = 0
        self.connected = False
        self.last_connected = 0
        self.last_disconnected = 0
        self.outage_started = 0
        self.ever_connected = False
        self.last_message = 0
        self.started_at = 0
        self._socket = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    @property
    def enabled(self):
        parsed = urllib.parse.urlsplit(self.base_url)
        return bool(websocket and parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and self.ip and self.token)

    def start(self):
        if not self.enabled or (self._thread and self._thread.is_alive()):
            return
        self.started_at = time.time()
        self._thread = threading.Thread(target=self._run, name=f"kui-realtime-{self.role}", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        try:
            if self._socket: self._socket.close()
        except Exception:
            pass

    def send(self, data, message_type="status"):
        with self._lock:
            if not self.connected or not self._socket:
                return False
            self.seq += 1
            envelope = {
                "v": 1,
                "role": self.role,
                "ip": self.ip,
                "boot_id": self.boot_id,
                "seq": self.seq,
                "ts": int(time.time() * 1000),
                "type": message_type,
                "data": data,
            }
            try:
                self._socket.send(json.dumps(envelope, separators=(",", ":")))
                return True
            except Exception:
                self.connected = False
                if not self.outage_started:
                    self.outage_started = time.time()
                self.last_disconnected = self.outage_started
                if self.on_message:
                    try: self.on_message({"type": "transport.disconnected"})
                    except Exception: pass
                return False

    def _websocket_url(self):
        if not self.enabled:
            raise ValueError("realtime URL must use HTTPS")
        scheme = "wss"
        base = self.base_url.split("://", 1)[-1]
        query = urllib.parse.urlencode({"ip": self.ip, "role": self.role})
        return f"{scheme}://{base}/agent/ws?{query}"

    def _run(self):
        delay = 1
        # 强制 IPv4 解析：这台 VPS 的 IPv6 出口不通，握手必然超时。
        # 必须在每次 create_connection 之前生效，并在 finally 里还原，
        # 否则会污染进程内其它模块（如 sing-box 客户端配置）的解析。
        restore_getaddrinfo = _prefer_reachable_family(self.base_url)
        while not self._stop.is_set():
            try:
                self._socket = websocket.create_connection(
                    self._websocket_url(),
                    header=[f"Authorization: {self.token}"],
                    timeout=30,
                    sslopt={"cert_reqs": ssl.CERT_REQUIRED},
                    enable_multithread=True,
                )
                self._socket.settimeout(45)
                self.connected = True
                self.last_connected = time.time()
                self.outage_started = 0
                self.ever_connected = True
                # 之前只在失败时静默重试，成功连上也不留痕迹，
                # 导致「通道到底有没有建起来」在日志里完全看不出来。
                print(f"[realtime] connected to {self.base_url} (role={self.role})", flush=True)
                if self.on_message:
                    try: self.on_message({"type": "transport.connected"})
                    except Exception: pass
                delay = 1
                self.send({"capabilities": ["http-fallback", "config-refresh", "config-result"]}, "hello")
                while not self._stop.is_set():
                    try:
                        raw = self._socket.recv()
                        if raw is None:
                            break
                        self.last_message = time.time()
                        if isinstance(raw, str) and raw == "pong":
                            continue
                        if self.on_message and isinstance(raw, str):
                            try: self.on_message(json.loads(raw))
                            except Exception: pass
                    except websocket.WebSocketTimeoutException:
                        try: self._socket.ping()
                        except Exception: break
            except Exception as error:
                # 之前这里是 `except Exception: pass`，握手失败在 journalctl 里
                # 一条痕迹都没有，排查「为什么配置变更要等 30s+」只能靠猜。
                # 现在只在「曾经连上过」或「连接失败累计到关键节点」时打印，
                # 避免首次就失败时刷屏，同时保留 type+原因。
                self._failure_count = getattr(self, "_failure_count", 0) + 1
                if self.ever_connected or self._failure_count in (1, 5) or self._failure_count % 20 == 0:
                    print(
                        f"[realtime] connect failed (#{self._failure_count}) "
                        f"{type(error).__name__}: {str(error)[:160]}",
                        flush=True,
                    )
            finally:
                self.connected = False
                if not self.outage_started:
                    self.outage_started = time.time()
                self.last_disconnected = self.outage_started
                if self.on_message:
                    try: self.on_message({"type": "transport.disconnected"})
                    except Exception: pass
                try:
                    if self._socket: self._socket.close()
                except Exception:
                    pass
                self._socket = None
                if not self.ever_connected and not self._stop.is_set():
                    # 退避上限 30s：连不上时不至于把 CPU 打满，连上后立即回到 1s
                    delay = min(delay * 2, 30)
                    if self._stop.wait(delay):
                        break

        if restore_getaddrinfo is not None:
            socket.getaddrinfo = restore_getaddrinfo
            self._stop.wait(delay + random.random())
            delay = min(delay * 2, 30)
