from __future__ import annotations

import argparse
import json
import os
import select
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

APP = "KafePin Web Limit Agent"
VERSION = "4.0.5-test1"
CONTROL_PORT = 17906
PROXY_PORT = 17907
DEFAULT_DOWN_MBPS = 50.0
DEFAULT_UP_MBPS = 10.0
STATE_DIR = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "KafePin" / "WebLimit"
STATE_FILE = STATE_DIR / "state.json"
SECRET_FILE = STATE_DIR / "control.key"
POLICY_BACKUP_FILE = STATE_DIR / "browser-policy-backup.json"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load_secret() -> str:
    env = os.environ.get("KAFEPIN_WEB_LIMIT_KEY", "").strip()
    if env:
        return env
    try:
        return SECRET_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


class TokenBucket:
    """Global byte scheduler shared by every proxied connection."""
    def __init__(self, mbps: float):
        self.lock = threading.Lock()
        self.rate = max(float(mbps), 0.01) * 1_000_000 / 8.0
        self.next_time = time.monotonic()

    def set_mbps(self, mbps: float) -> None:
        with self.lock:
            self.rate = max(float(mbps), 0.01) * 1_000_000 / 8.0
            self.next_time = min(self.next_time, time.monotonic() + 0.20)

    def consume(self, nbytes: int) -> None:
        if nbytes <= 0:
            return
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_time)
            wait = max(0.0, start - now)
            self.next_time = start + (float(nbytes) / self.rate)
        if wait > 0:
            time.sleep(wait)


class AgentState:
    def __init__(self):
        self.lock = threading.RLock()
        self.enabled = False
        self.down_mbps = DEFAULT_DOWN_MBPS
        self.up_mbps = DEFAULT_UP_MBPS
        self.updated_at = 0
        self.last_error = ""
        self.down_bucket = TokenBucket(self.down_mbps)
        self.up_bucket = TokenBucket(self.up_mbps)
        self.load()

    def load(self):
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            self.enabled = bool(data.get("enabled", False))
            self.down_mbps = float(data.get("downMbps", DEFAULT_DOWN_MBPS))
            self.up_mbps = float(data.get("upMbps", DEFAULT_UP_MBPS))
            self.updated_at = int(data.get("updatedAt", 0))
        except Exception:
            pass
        self.down_bucket.set_mbps(self.down_mbps)
        self.up_bucket.set_mbps(self.up_mbps)

    def save(self):
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text(json.dumps({
                "enabled": self.enabled,
                "downMbps": self.down_mbps,
                "upMbps": self.up_mbps,
                "updatedAt": self.updated_at,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception as exc:
            self.last_error = str(exc)

    def set_enabled(self, enabled: bool, down: float | None = None, up: float | None = None):
        with self.lock:
            if down is not None:
                self.down_mbps = max(1.0, min(float(down), 1000.0))
                self.down_bucket.set_mbps(self.down_mbps)
            if up is not None:
                self.up_mbps = max(1.0, min(float(up), 1000.0))
                self.up_bucket.set_mbps(self.up_mbps)
            self.enabled = bool(enabled)
            self.updated_at = _now_ms()
            self.last_error = ""
            self.save()
            try:
                apply_browser_policy(self.enabled)
            except Exception as exc:
                self.last_error = f"browser policy: {exc}"

    def snapshot(self):
        with self.lock:
            return {
                "ok": True,
                "app": APP,
                "version": VERSION,
                "enabled": self.enabled,
                "downMbps": self.down_mbps,
                "upMbps": self.up_mbps,
                "mode": "browser-only-pac-proxy",
                "failOpen": True,
                "proxyPort": PROXY_PORT,
                "controlPort": CONTROL_PORT,
                "lastError": self.last_error,
                "updatedAt": self.updated_at,
            }


STATE = AgentState()


def _is_windows() -> bool:
    return os.name == "nt"


def apply_browser_policy(enabled: bool) -> None:
    """Apply only Chrome/Edge proxy policy and restore prior policy on disable."""
    if not _is_windows():
        return
    import winreg
    pac_url = f"http://127.0.0.1:{CONTROL_PORT}/proxy.pac"
    roots = [r"SOFTWARE\Policies\Google\Chrome", r"SOFTWARE\Policies\Microsoft\Edge"]

    def read_value(subkey: str, name: str):
        try:
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, subkey, 0, winreg.KEY_READ)
            try:
                value, kind = winreg.QueryValueEx(key, name)
                return {"exists": True, "value": value, "kind": int(kind)}
            finally:
                winreg.CloseKey(key)
        except FileNotFoundError:
            return {"exists": False}

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if enabled and not POLICY_BACKUP_FILE.exists():
        backup = {subkey: {name: read_value(subkey, name) for name in ("ProxyMode", "ProxyPacUrl")} for subkey in roots}
        POLICY_BACKUP_FILE.write_text(json.dumps(backup, ensure_ascii=False, indent=2), encoding="utf-8")

    backup = {}
    if not enabled:
        try:
            backup = json.loads(POLICY_BACKUP_FILE.read_text(encoding="utf-8"))
        except Exception:
            backup = {}

    for subkey in roots:
        key = winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, subkey, 0, winreg.KEY_SET_VALUE)
        try:
            if enabled:
                winreg.SetValueEx(key, "ProxyMode", 0, winreg.REG_SZ, "pac_script")
                winreg.SetValueEx(key, "ProxyPacUrl", 0, winreg.REG_SZ, pac_url)
            else:
                previous = backup.get(subkey, {}) if isinstance(backup, dict) else {}
                for name in ("ProxyMode", "ProxyPacUrl"):
                    item = previous.get(name, {}) if isinstance(previous, dict) else {}
                    if item.get("exists"):
                        winreg.SetValueEx(key, name, 0, int(item.get("kind", winreg.REG_SZ)), item.get("value"))
                    else:
                        try:
                            winreg.DeleteValue(key, name)
                        except FileNotFoundError:
                            pass
        finally:
            winreg.CloseKey(key)
    if not enabled:
        try:
            POLICY_BACKUP_FILE.unlink()
        except FileNotFoundError:
            pass


def pac_text() -> str:
    return f'''function FindProxyForURL(url, host) {{
  if (isPlainHostName(host) || host == "localhost" || dnsDomainIs(host, ".local")) return "DIRECT";
  var ip = dnsResolve(host);
  if (ip) {{
    if (isInNet(ip, "10.0.0.0", "255.0.0.0")) return "DIRECT";
    if (isInNet(ip, "172.16.0.0", "255.240.0.0")) return "DIRECT";
    if (isInNet(ip, "192.168.0.0", "255.255.0.0")) return "DIRECT";
    if (isInNet(ip, "127.0.0.0", "255.0.0.0")) return "DIRECT";
    if (isInNet(ip, "169.254.0.0", "255.255.0.0")) return "DIRECT";
  }}
  return "PROXY 127.0.0.1:{PROXY_PORT}; DIRECT";
}}\n'''


class ControlHandler(BaseHTTPRequestHandler):
    server_version = "KafePinWebLimit/4.0.5"
    def log_message(self, *_args): pass
    def _auth(self) -> bool:
        secret = _load_secret()
        return bool(secret) and self.headers.get("X-KafePin-Token", "") == secret
    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.split("?", 1)[0] == "/proxy.pac":
            body = pac_text().encode("utf-8"); self.send_response(200); self.send_header("Content-Type", "application/x-ns-proxy-autoconfig"); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-cache, no-store"); self.end_headers(); self.wfile.write(body); return
        if self.path.split("?", 1)[0] == "/api/health":
            if not self._auth(): return self._json({"ok": False, "error": "unauthorized"}, 401)
            return self._json(STATE.snapshot())
        self._json({"ok": False, "error": "not found"}, 404)
    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/control": return self._json({"ok": False, "error": "not found"}, 404)
        if not self._auth(): return self._json({"ok": False, "error": "unauthorized"}, 401)
        try:
            length = max(0, min(int(self.headers.get("Content-Length", "0") or 0), 65536))
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            action = str(data.get("action") or "").lower()
            if action not in ("enable", "disable"): return self._json({"ok": False, "error": "invalid action"}, 400)
            STATE.set_enabled(action == "enable", data.get("downMbps"), data.get("upMbps")); return self._json(STATE.snapshot())
        except Exception as exc:
            return self._json({"ok": False, "error": str(exc)}, 500)


class ProxyHandler(socketserver.StreamRequestHandler):
    timeout = 20
    def handle(self):
        self.connection.settimeout(20); line = self.rfile.readline(65536)
        if not line: return
        try: method, target, version = line.decode("iso-8859-1").rstrip("\r\n").split(" ", 2)
        except Exception: return
        headers = []
        while True:
            h = self.rfile.readline(65536)
            if not h or h in (b"\r\n", b"\n"): break
            headers.append(h)
        if method.upper() == "CONNECT": return self._connect_tunnel(target)
        return self._http_forward(method, target, version, headers)
    def _connect_tunnel(self, target: str):
        if ":" in target: host, port_text = target.rsplit(":", 1); port = int(port_text)
        else: host, port = target, 443
        remote = socket.create_connection((host, port), timeout=12)
        try:
            self.connection.sendall(b"HTTP/1.1 200 Connection Established\r\nProxy-Agent: KafePin\r\n\r\n"); self._pump(remote)
        finally: remote.close()
    def _http_forward(self, method: str, target: str, version: str, headers: list[bytes]):
        parsed = urlsplit(target)
        if parsed.scheme and parsed.hostname:
            host = parsed.hostname; port = parsed.port or (443 if parsed.scheme == "https" else 80); path = parsed.path or "/"; path += ("?" + parsed.query) if parsed.query else ""
        else:
            host_header = ""
            for h in headers:
                if h.lower().startswith(b"host:"): host_header = h.split(b":", 1)[1].strip().decode("iso-8859-1"); break
            if not host_header: return
            if ":" in host_header: host, port_text = host_header.rsplit(":", 1); port = int(port_text)
            else: host, port = host_header, 80
            path = target
        remote = socket.create_connection((host, port), timeout=12)
        try:
            clean_headers = [h for h in headers if not h.lower().startswith((b"proxy-connection:", b"connection:"))]
            req = f"{method} {path} {version}\r\n".encode("iso-8859-1") + b"".join(clean_headers) + b"Connection: close\r\n\r\n"
            if STATE.enabled: STATE.up_bucket.consume(len(req))
            remote.sendall(req)
            content_length = 0
            for h in headers:
                if h.lower().startswith(b"content-length:"):
                    try: content_length = int(h.split(b":", 1)[1].strip())
                    except Exception: content_length = 0
            remaining = content_length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: break
                if STATE.enabled: STATE.up_bucket.consume(len(chunk))
                remote.sendall(chunk); remaining -= len(chunk)
            while True:
                chunk = remote.recv(65536)
                if not chunk: break
                if STATE.enabled: STATE.down_bucket.consume(len(chunk))
                self.connection.sendall(chunk)
        finally: remote.close()
    def _pump(self, remote: socket.socket):
        sockets = [self.connection, remote]
        while True:
            readable, _, exceptional = select.select(sockets, [], sockets, 20)
            if exceptional or not readable: return
            for src in readable:
                try: data = src.recv(65536)
                except OSError: return
                if not data: return
                if src is self.connection:
                    if STATE.enabled: STATE.up_bucket.consume(len(data))
                    remote.sendall(data)
                else:
                    if STATE.enabled: STATE.down_bucket.consume(len(data))
                    self.connection.sendall(data)


class ThreadedProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def run():
    proxy = ThreadedProxy(("127.0.0.1", PROXY_PORT), ProxyHandler); control = ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), ControlHandler)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    try: control.serve_forever()
    finally: proxy.shutdown(); proxy.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--disable", action="store_true"); args = parser.parse_args()
    if args.disable: STATE.set_enabled(False)
    else: run()
