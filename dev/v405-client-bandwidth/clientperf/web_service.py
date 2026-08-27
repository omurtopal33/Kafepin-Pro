from __future__ import annotations

import concurrent.futures
import json
import re
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
PORT = 17896
CLIENT_MANAGER_URL = "http://127.0.0.1:17894/api/clients"
KAFEPIN_MASALAR_URL = "http://127.0.0.1:3000/api/masalar"
LIBRE_PORT = 8085
WEB_LIMIT_AGENT_PORT = 17906
WEB_LIMIT_DOWN_MBPS = 50.0
WEB_LIMIT_UP_MBPS = 10.0
WEB_LIMIT_KEY_FILE = Path(r"C:\ProgramData\KafePin\WebLimit\control.key")
SAMPLE_CACHE_SECONDS = 2.5
_cache: dict[str, tuple[float, dict]] = {}


def fetch_json(url: str, timeout: float = 1.8) -> object:
    request = Request(url, headers={"Accept": "application/json", "Cache-Control": "no-cache"})
    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8-sig"))


def web_limit_key() -> str:
    import os
    env = os.environ.get("KAFEPIN_WEB_LIMIT_KEY", "").strip()
    if env:
        return env
    try:
        return WEB_LIMIT_KEY_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def fetch_agent_health(ip: str, timeout: float = 0.7) -> dict:
    key = web_limit_key()
    if not ip or not key:
        return {"reachable": False, "enabled": False, "error": "agent key yok" if not key else "IP yok"}
    try:
        req = Request(f"http://{ip}:{WEB_LIMIT_AGENT_PORT}/api/health", headers={"Accept":"application/json", "X-KafePin-Token": key, "Cache-Control":"no-cache"})
        with urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8-sig"))
        if not isinstance(data, dict) or not data.get("ok"):
            return {"reachable": False, "enabled": False, "error": str((data or {}).get("error") if isinstance(data, dict) else "bad response")}
        return {
            "reachable": True,
            "enabled": bool(data.get("enabled")),
            "downMbps": float(data.get("downMbps") or 0),
            "upMbps": float(data.get("upMbps") or 0),
            "mode": str(data.get("mode") or ""),
            "failOpen": bool(data.get("failOpen", True)),
            "version": str(data.get("version") or ""),
            "error": str(data.get("lastError") or ""),
        }
    except Exception as exc:
        return {"reachable": False, "enabled": False, "error": str(exc)}


def control_agent(ip: str, enable: bool, down: float = WEB_LIMIT_DOWN_MBPS, up: float = WEB_LIMIT_UP_MBPS, timeout: float = 2.0) -> dict:
    key = web_limit_key()
    if not ip:
        return {"ok": False, "error": "IP yok"}
    if not key:
        return {"ok": False, "error": "KAFEPIN_WEB_LIMIT_KEY ayarlı değil"}
    body = json.dumps({"action": "enable" if enable else "disable", "downMbps": down, "upMbps": up}).encode("utf-8")
    req = Request(f"http://{ip}:{WEB_LIMIT_AGENT_PORT}/api/control", data=body, method="POST", headers={"Content-Type":"application/json", "Accept":"application/json", "X-KafePin-Token": key})
    try:
        with urlopen(req, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8-sig"))
        return data if isinstance(data, dict) else {"ok": False, "error": "bad response"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def parse_number(value: object) -> float | None:
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", str(value or ""))
    return float(match.group(0).replace(",", ".")) if match else None


def to_mbps(value: object) -> float | None:
    number = parse_number(value)
    if number is None:
        return None
    text = str(value or "").lower().replace(" ", "")
    if "gb/s" in text or "gbit/s" in text:
        return number * 8000.0
    if "mb/s" in text or "mbit/s" in text:
        return number * 8.0
    if "kb/s" in text or "kbit/s" in text:
        return number * 0.008
    if "b/s" in text:
        return number * 0.000008
    return number


def flatten(node: dict, hardware: str = "", group: str = "") -> list[dict]:
    hardware = str(node.get("HardwareId") or hardware or "")
    text = str(node.get("Text") or "")
    next_group = text if str(node.get("ImageURL") or "").endswith(("temperature.png", "load.png", "throughput.png", "ram.png")) else group
    rows: list[dict] = []
    value = str(node.get("Value") or "")
    if value:
        rows.append({"hardware": hardware.lower(), "group": group.lower(), "name": text.lower(), "value": value})
    for child in node.get("Children") or []:
        if isinstance(child, dict):
            rows.extend(flatten(child, hardware, next_group))
    return rows


def first_value(rows: list[dict], hardware_markers: tuple[str, ...], group: str, names: tuple[str, ...], converter=parse_number) -> float | None:
    for name in names:
        for row in rows:
            if any(marker in row["hardware"] for marker in hardware_markers) and group in row["group"] and name in row["name"]:
                parsed = converter(row["value"])
                if parsed is not None:
                    return parsed
    return None


def ping_ms(ip: str) -> int | None:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        started = time.perf_counter()
        result = subprocess.run(["ping.exe", "-n", "1", "-w", "650", ip], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1.2, check=False, creationflags=flags)
        return round((time.perf_counter() - started) * 1000) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def client_masa_number(client: dict) -> int | None:
    for value in (client.get("ClientName"), client.get("ComputerName"), client.get("Name")):
        text = str(value or "").strip()
        match = re.search(r"(\d{1,3})\s*$", text)
        if match:
            number = int(match.group(1))
            if 1 <= number <= 999:
                return number
    return None


def read_client_sensor(client: dict, link_speeds: dict[int, float] | None = None) -> dict:
    ip = str(client.get("ClientIP") or "").strip()
    key = ip or str(client.get("ClientGuid") or client.get("ClientName") or "")
    now = time.monotonic()
    masa_no = client_masa_number(client)
    link_speed = float((link_speeds or {}).get(masa_no, 0) or 0) if masa_no else 0.0
    cached = _cache.get(key)
    if cached and now - cached[0] < SAMPLE_CACHE_SECONDS:
        value = dict(cached[1])
        value["linkSpeedMbps"] = link_speed or value.get("linkSpeedMbps")
        return value
    result = {
        "name": str(client.get("ClientName") or "Masa"), "ip": ip,
        "online": bool(client.get("deviceOnline")), "status": str(client.get("status") or ""), "sensorOnline": False,
        "cpuLoad": None, "ramLoad": None, "cpuTemp": None, "gpuTemp": None, "downloadMbps": None, "uploadMbps": None, "pingMs": None,
        "linkSpeedMbps": link_speed or None, "message": "Libre Hardware Monitor verisi bekleniyor",
        "webLimit": {"reachable": False, "enabled": False, "error": "bekleniyor"},
    }
    if not ip or not result["online"]:
        result["message"] = "Client kapalı / ulaşılamıyor"
        result["webLimit"] = fetch_agent_health(ip) if ip else {"reachable": False, "enabled": False, "error": "IP yok"}
        _cache[key] = (now, result)
        return dict(result)
    try:
        data = fetch_json(f"http://{ip}:{LIBRE_PORT}/data.json")
        rows = flatten(data)
        result.update({
            "sensorOnline": True,
            "cpuLoad": first_value(rows, ("/intelcpu", "/amdcpu"), "load", ("cpu total",)),
            "ramLoad": first_value(rows, ("/ram",), "load", ("memory",)),
            "cpuTemp": first_value(rows, ("/intelcpu", "/amdcpu"), "temperatures", ("cpu package", "core max", "cpu core")),
            "gpuTemp": first_value(rows, ("/gpu-",), "temperatures", ("gpu core", "gpu temperature")),
            "downloadMbps": first_value(rows, ("/nic/",), "throughput", ("download speed", "receive speed"), to_mbps),
            "uploadMbps": first_value(rows, ("/nic/",), "throughput", ("upload speed", "send speed"), to_mbps),
            "pingMs": ping_ms(ip), "message": "Libre Hardware Monitor bağlı",
        })
    except Exception:
        result["message"] = "Libre Hardware Monitor servisi kapalı (http://IP:8085)"
        result["pingMs"] = ping_ms(ip)
    result["webLimit"] = fetch_agent_health(ip)
    _cache[key] = (now, result)
    return dict(result)


def list_metrics() -> list[dict]:
    source = fetch_json(CLIENT_MANAGER_URL, timeout=2.5)
    clients = source.get("clients") or [] if isinstance(source, dict) else []
    link_speeds: dict[int, float] = {}
    try:
        masalar = fetch_json(KAFEPIN_MASALAR_URL, timeout=1.2)
        if isinstance(masalar, list):
            for row in masalar:
                if not isinstance(row, dict): continue
                masa_no = int(row.get("masa") or 0); speed = float(row.get("netSpeed") or 0)
                if masa_no > 0 and speed > 0: link_speeds[masa_no] = speed
    except Exception:
        pass
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, max(1, len(clients)))) as pool:
        return [future.result() for future in [pool.submit(read_client_sensor, client, link_speeds) for client in clients]]


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass
    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store"); self.send_header("X-KafePin-Performance-Isolation", "separate-loopback-service"); self.end_headers(); self.wfile.write(body)
    def serve_file(self, relative: str):
        requested = (WEB / relative).resolve()
        if WEB not in requested.parents or not requested.is_file(): return self.send_json({"ok": False, "error": "Bulunamadı"}, 404)
        content_type = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript"}.get(requested.suffix, "application/octet-stream")
        body = requested.read_bytes(); self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(body)
    def read_json_body(self):
        length = max(0, min(int(self.headers.get("Content-Length", "0") or 0), 65536))
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")
    def do_POST(self):
        try:
            path = urlparse(self.path).path; data = self.read_json_body()
            if path == "/api/web-limit":
                ip = str(data.get("ip") or "").strip(); result = control_agent(ip, bool(data.get("enable")))
                return self.send_json(result, 200 if result.get("ok") else 502)
            if path == "/api/web-limit/all":
                enable = bool(data.get("enable")); source = fetch_json(CLIENT_MANAGER_URL, timeout=2.5); clients = source.get("clients") or [] if isinstance(source, dict) else []; outcomes = []
                for client in clients:
                    ip = str(client.get("ClientIP") or "").strip(); name = str(client.get("ClientName") or client.get("ComputerName") or ip or "Masa")
                    if not ip or not bool(client.get("deviceOnline")):
                        outcomes.append({"name": name, "ip": ip, "ok": False, "skipped": True, "error": "offline/IP yok"}); continue
                    r = control_agent(ip, enable); outcomes.append({"name": name, "ip": ip, **r})
                return self.send_json({"ok": True, "enable": enable, "results": outcomes})
            return self.send_json({"ok": False, "error": "Bulunamadı"}, 404)
        except Exception as exc:
            return self.send_json({"ok": False, "error": str(exc)}, 500)
    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/health": return self.send_json({"ok": True, "app": "Client Performans PRO", "port": PORT, "source": "Libre Hardware Monitor", "everyCafeReadOnly": True})
            if path == "/api/metrics":
                metrics = list_metrics(); return self.send_json({"ok": True, "source": "Libre Hardware Monitor", "everyCafeReadOnly": True, "updatedAt": int(time.time() * 1000), "clients": metrics})
            self.serve_file("index.html" if path in ("/", "/index.html") else path.lstrip("/"))
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
