from __future__ import annotations

import base64
import concurrent.futures
import ctypes
import json
import re
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlparse
from ctypes import wintypes


ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
PORT = 17894
EVERYCAFE_DB = Path(r"C:\Program Files (x86)\EveryCafeManager\ecmdata.ecm")
EVERYCAFE_MANAGER = Path(r"C:\Program Files (x86)\EveryCafeManager\EveryCafeManager.exe")
ALLOWED_ACTIONS = {"wake", "restart", "terminate_apps"}
ALLOWED_SESSION_MODES = {"unlimited", "timed", "free"}
ALLOWED_TIMES = {15, 30, 45, 60, 90, 120, 180}
MAX_ADDITIONAL_MINUTES = 1440
REACHABILITY_CACHE_SECONDS = 3.0
_reachability_cache: dict[str, tuple[float, bool | None]] = {}
_reachability_lock = threading.Lock()
_session_jobs: dict[str, dict] = {}
_session_jobs_lock = threading.Lock()
_client_session_locks: dict[str, threading.Lock] = {}


def set_job(job_id: str, **values):
    with _session_jobs_lock:
        job = _session_jobs.get(job_id)
        if job:
            job.update(values)
            job["updatedAt"] = int(time.time() * 1000)


def get_job(job_id: str) -> dict | None:
    with _session_jobs_lock:
        job = _session_jobs.get(job_id)
        return dict(job) if job else None


def probe_reachable(ip: str) -> bool | None:
    """Return live ICMP reachability without opening a visible console window."""
    target = str(ip or "").strip()
    if not target:
        return False
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            ["ping.exe", "-n", "1", "-w", "500", target],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1.2,
            check=False,
            creationflags=creation_flags,
        )
        return completed.returncode == 0
    except (OSError, subprocess.SubprocessError):
        # Ping aracı kullanılamazsa EveryCafe'nin mevcut cihaz bilgisine
        # geri düşülür; panel yanlışlıkla tüm masaları kapalı göstermez.
        return None


def live_reachability(ips: list[str]) -> dict[str, bool | None]:
    """Probe stale addresses concurrently and cache the short-lived result."""
    now = time.monotonic()
    unique_ips = list(dict.fromkeys(str(ip or "").strip() for ip in ips if str(ip or "").strip()))
    resolved: dict[str, bool | None] = {}
    stale: list[str] = []
    with _reachability_lock:
        for ip in unique_ips:
            cached = _reachability_cache.get(ip)
            if cached and now - cached[0] < REACHABILITY_CACHE_SECONDS:
                resolved[ip] = cached[1]
            else:
                stale.append(ip)

    if stale:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(stale))) as pool:
            checks = dict(zip(stale, pool.map(probe_reachable, stale)))
        checked_at = time.monotonic()
        with _reachability_lock:
            for ip, reachable in checks.items():
                _reachability_cache[ip] = (checked_at, reachable)
                resolved[ip] = reachable
    return resolved


def everycafe_connection() -> sqlite3.Connection:
    if not EVERYCAFE_DB.is_file():
        raise FileNotFoundError(f"EveryCafe veritabanı bulunamadı: {EVERYCAFE_DB}")
    # KafePin kurallarındaki değişmez sınır: kaynak yalnız okunur açılır.
    conn = sqlite3.connect(f"file:{EVERYCAFE_DB.as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def status_label(value: int, has_session: bool, reachable: bool) -> str:
    # Fiziksel bağlantı yoksa EveryCafe'de kalmış eski Çalışıyor/Beklemede
    # değeri kullanıcıya gösterilmez. Oturum bilgisi kartın ayrı alanında
    # korunur ve ping hiçbir oturumu kapatmaz.
    if not reachable:
        return "Kapalı"
    if has_session:
        return "Oturum açık"
    if value == 2:
        return "Beklemede"
    return "Online"


def list_clients() -> list[dict]:
    sql = """
        SELECT c.ClientName,c.ClientGuid,c.ClientIP,c.ClientMac,
               COALESCE(c.ClientStatus,0) AS ClientStatus,
               COALESCE(c.ClientIsActive,0) AS ClientIsActive,
               s.SessionID,s.StartDate,s.EndDate,s.SessionType,s.SessionTypeText,
               s.SessionDetailDataText,s.GiftTime
          FROM Clients c
          LEFT JOIN Sessions s
            ON s.ClientGuid=c.ClientGuid
           AND COALESCE(s.IsActive,0)=1
           AND COALESCE(s.Deleted,0)=0
         WHERE COALESCE(c.ClientIsDeleted,0)=0
           AND TRIM(COALESCE(c.ClientIP,''))<>''
         ORDER BY c.ClientName COLLATE NOCASE
    """
    with everycafe_connection() as conn:
        rows = conn.execute(sql).fetchall()
    reachability = live_reachability([str(row["ClientIP"] or "") for row in rows])
    result = []
    for row in rows:
        item = dict(row)
        status = int(item.get("ClientStatus") or 0)
        active_session = bool(item.get("SessionID"))
        item["sessionOpen"] = active_session
        # Kartın üst gruba çıkması EveryCafe hesabına değil, gerçek cihaz
        # bağlantı durumuna bağlıdır. Böylece açık hesap bırakılmış olsa bile
        # kapanan PC doğal masa sırasındaki offline yerine geri döner.
        live_online = reachability.get(str(item.get("ClientIP") or "").strip())
        item["deviceOnline"] = live_online if live_online is not None else status in (1, 2)
        item["statusText"] = status_label(status, active_session, bool(item["deviceOnline"]))
        item["statusClass"] = (
            "offline" if not item["deviceOnline"] else
            "open" if active_session else
            "idle" if status == 2 else
            "online"
        )
        item["sessionMode"] = str(item.get("SessionTypeText") or item.get("SessionDetailDataText") or "-") if active_session else "-"
        item["sessionStart"] = int(item.get("StartDate") or 0) * 1000
        item["sessionEnd"] = int(item.get("EndDate") or 0) * 1000
        result.append(item)
    # Gerçekten çalışan/bekleyen bilgisayarlar önce; kapalı/ulaşılamayanlar
    # sonra gösterilir. Oturum açıklığı cihaz sırasını sabitlemez. Masa 2,
    # Masa 10 gibi adlar alfabetik değil doğal numara sırasıyla dizilir.
    def natural_name(value: object) -> list[tuple[int, object]]:
        return [(0, int(part)) if part.isdigit() else (1, part.casefold())
                for part in re.split(r"(\d+)", str(value or ""))]

    result.sort(key=lambda item: (
        0 if item.get("deviceOnline") else 1,
        natural_name(item.get("ClientName")),
    ))
    return result


def normalise_mac(value: str) -> bytes:
    raw = "".join(ch for ch in str(value or "") if ch in "0123456789abcdefABCDEF")
    if len(raw) != 12:
        raise ValueError("Bu masa için geçerli MAC adresi bulunamadı.")
    return bytes.fromhex(raw)


def directed_broadcast(ip: str) -> str:
    parts = str(ip or "").split(".")
    if len(parts) == 4 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
        return ".".join(parts[:3] + ["255"])
    return "255.255.255.255"


def wake_client(client_name: str) -> dict:
    client = next((item for item in list_clients() if item["ClientName"] == client_name), None)
    if not client:
        raise ValueError("Masa bulunamadı.")
    mac = normalise_mac(client.get("ClientMac", ""))
    packet = b"\xff" * 6 + mac * 16
    target = directed_broadcast(client.get("ClientIP", ""))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.sendto(packet, (target, 9))
        sock.sendto(packet, (target, 7))
    return {"client": client_name, "broadcast": target}


def find_client(client_name: str) -> dict:
    client = next((item for item in list_clients() if item["ClientName"] == client_name), None)
    if not client:
        raise ValueError("Masa bulunamadı.")
    ip = str(client.get("ClientIP") or "").strip()
    if not ip:
        raise ValueError("Bu masa için geçerli IP adresi bulunamadı.")
    return client


def send_client_command(client_name: str, command: str) -> dict:
    """EveryCafe istemci kontrol paketi; oturum/DB verisi yazmaz."""
    client = find_client(client_name)
    packet = base64.b64encode(command.encode("utf-8"))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.sendto(packet, (client["ClientIP"], 45456))
    return {"client": client_name, "command": command.split(":", 1)[0]}


def restart_client(client_name: str) -> dict:
    return send_client_command(client_name, "RESTARTCLIENT:NoData")


def terminate_client_apps(client_name: str) -> dict:
    """EveryCafe's verified TERMINATEALLAPPS client command; no DB write."""
    return send_client_command(client_name, "TERMINATEALLAPPS:NoData")


def session_state(client_name: str) -> dict:
    """Read-only proof of an active or EveryCafe-queued session."""
    with everycafe_connection() as conn:
        client = conn.execute(
            "SELECT ClientGuid,ClientStatus,ClientIP FROM Clients WHERE ClientName=? AND COALESCE(ClientIsDeleted,0)=0",
            (client_name,),
        ).fetchone()
        if not client:
            raise ValueError("Masa bulunamadı.")
        active = conn.execute(
            """SELECT SessionID,SessionTypeText,StartDate,EndDate
                 FROM Sessions
                WHERE ClientGuid=? AND COALESCE(IsActive,0)=1 AND COALESCE(Deleted,0)=0
                ORDER BY StartDate DESC LIMIT 1""",
            (client["ClientGuid"],),
        ).fetchone()
        queued = conn.execute(
            """SELECT Command,SessionTypeText,SessionValue,AddDate
                 FROM WolSessionQueue
                WHERE ClientGuid=? AND COALESCE(CommandForwarded,0)=0
                ORDER BY AddDate DESC LIMIT 1""",
            (client["ClientGuid"],),
        ).fetchone()
    return {
        "clientGuid": client["ClientGuid"],
        "clientStatus": int(client["ClientStatus"] or 0),
        "clientIP": str(client["ClientIP"] or ""),
        "active": dict(active) if active else None,
        "queued": dict(queued) if queued else None,
    }


def _enum_everycafe_windows() -> list[int]:
    user32 = ctypes.windll.user32
    found: list[int] = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            if "EVERYCAFE MANAGER" in title.value.upper():
                found.append(int(hwnd))
        return True

    user32.EnumWindows(callback_type(callback), 0)
    return found


def _window_process_id(hwnd: int) -> int:
    process_id = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    return int(process_id.value)


def _same_process_foreground(hwnd: int) -> bool:
    foreground = int(ctypes.windll.user32.GetForegroundWindow() or 0)
    return bool(foreground and _window_process_id(foreground) == _window_process_id(hwnd))


def activate_everycafe_window(hwnd: int, timeout: float = 2.5) -> None:
    """Bring Qt EveryCafe to the interactive foreground and prove it before input."""
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        foreground = int(user32.GetForegroundWindow() or 0)
        current_thread = int(kernel32.GetCurrentThreadId())
        foreground_thread = int(user32.GetWindowThreadProcessId(foreground, None) or 0) if foreground else 0
        target_thread = int(user32.GetWindowThreadProcessId(hwnd, None) or 0)
        attached_foreground = bool(foreground_thread and foreground_thread != current_thread)
        attached_target = bool(target_thread and target_thread != current_thread)
        try:
            if attached_foreground:
                user32.AttachThreadInput(current_thread, foreground_thread, True)
            if attached_target:
                user32.AttachThreadInput(current_thread, target_thread, True)
            user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
            # Qt can remain behind KafePin even when SetForegroundWindow returns
            # success. Keep it topmost only for the short automation transaction.
            user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
            user32.BringWindowToTop(hwnd)
            # A synthetic Alt release opens Windows' documented foreground
            # transition window for an interactive process. SwitchToThisWindow
            # is retained as a Qt5-specific fallback used by EveryCafe 1.0.235.
            user32.keybd_event(0x12, 0, 0, 0)
            user32.keybd_event(0x12, 0, 2, 0)
            user32.SetForegroundWindow(hwnd)
            user32.SetActiveWindow(hwnd)
            switch_to = getattr(user32, "SwitchToThisWindow", None)
            if switch_to:
                switch_to(hwnd, True)
            user32.SetFocus(hwnd)
        finally:
            if attached_target:
                user32.AttachThreadInput(current_thread, target_thread, False)
            if attached_foreground:
                user32.AttachThreadInput(current_thread, foreground_thread, False)
        if _same_process_foreground(hwnd):
            return
        time.sleep(0.08)
    raise RuntimeError("EveryCafe penceresi güvenli şekilde öne alınamadı; masa komutu gönderilmedi.")


def restore_window_after_automation(hwnd: int, previous: int, was_visible: bool) -> None:
    user32 = ctypes.windll.user32
    user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)  # HWND_NOTOPMOST
    if not was_visible:
        user32.ShowWindow(hwnd, 0)
    if previous and previous != hwnd:
        user32.SetForegroundWindow(previous)


def ensure_everycafe_window(timeout: float = 8.0) -> tuple[int, bool]:
    """Ask EveryCafe's singleton to expose its own window; never start a second manager."""
    if not EVERYCAFE_MANAGER.is_file():
        raise FileNotFoundError(f"EveryCafe Manager bulunamadı: {EVERYCAFE_MANAGER}")
    windows = _enum_everycafe_windows()
    was_visible = bool(windows and ctypes.windll.user32.IsWindowVisible(windows[0]))
    if not windows:
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(
            [str(EVERYCAFE_MANAGER)],
            cwd=str(EVERYCAFE_MANAGER.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation_flags,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(0.25)
            windows = _enum_everycafe_windows()
            if windows:
                break
    if not windows:
        raise RuntimeError("EveryCafe penceresi otomatik açılamadı. EveryCafe Manager çalışır durumda olmalı.")
    hwnd = windows[0]
    try:
        activate_everycafe_window(hwnd)
    except Exception:
        if not was_visible:
            ctypes.windll.user32.ShowWindow(hwnd, 0)
        raise
    time.sleep(0.20)
    return hwnd, was_visible


def everycafe_card_point(hwnd: int, client_name: str) -> tuple[int, int]:
    """Locate the card using EveryCafe's read-only client order and responsive flow grid."""
    with everycafe_connection() as conn:
        rows = conn.execute(
            """SELECT c.ClientName,COALESCE(co.ClientOrder,99999) ClientOrder
                 FROM Clients c LEFT JOIN ClientOrder co ON co.ClientName=c.ClientName
                WHERE COALESCE(c.ClientIsDeleted,0)=0 AND COALESCE(c.ClientIsActive,0)=1
                  AND c.ClientType=2 AND TRIM(COALESCE(c.ClientIP,''))<>''
                ORDER BY ClientOrder,c.ClientName COLLATE NOCASE"""
        ).fetchall()
    names = [str(row["ClientName"]) for row in rows]
    if client_name not in names:
        raise ValueError("Masa EveryCafe görünüm sıralamasında bulunamadı.")

    rect = wintypes.RECT()
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("EveryCafe pencere ölçüsü okunamadı.")
    width = rect.right - rect.left
    dpi = ctypes.windll.user32.GetDpiForWindow(hwnd) if hasattr(ctypes.windll.user32, "GetDpiForWindow") else 96
    scale = max(0.75, float(dpi or 96) / 96.0)
    cell_w, cell_h = 152 * scale, 181 * scale
    # Sol yönetim şeridi ve sağ bilgi paneli EveryCafe'nin kendi sabit alanlarıdır.
    grid_width = max(cell_w, width - (632 * scale))
    columns = max(1, int(grid_width // cell_w))
    # İlk hücre EveryCafe'nin "Doğrudan Satış" kartıdır.
    index = names.index(client_name) + 1
    row, column = divmod(index, columns)
    x = int(rect.left + 347 * scale + column * cell_w)
    y = int(rect.top + 238 * scale + row * cell_h)
    if not (rect.left <= x < rect.right and rect.top <= y < rect.bottom):
        raise RuntimeError("EveryCafe masa kartı pencere dışında kaldı.")
    return x, y


def _mouse_click(x: int, y: int, double: bool = False, right: bool = False):
    user32 = ctypes.windll.user32
    user32.SetCursorPos(x, y)
    down = 0x0008 if right else 0x0002
    up = 0x0010 if right else 0x0004
    for _ in range(2 if double else 1):
        user32.mouse_event(down, 0, 0, 0, 0)
        user32.mouse_event(up, 0, 0, 0, 0)
        time.sleep(0.10)


def _key(vk: int, modifiers: tuple[int, ...] = ()):
    user32 = ctypes.windll.user32
    for mod in modifiers:
        user32.keybd_event(mod, 0, 0, 0)
    user32.keybd_event(vk, 0, 0, 0)
    user32.keybd_event(vk, 0, 2, 0)
    for mod in reversed(modifiers):
        user32.keybd_event(mod, 0, 2, 0)


def _type_digits(value: int):
    for char in str(value):
        _key(0x30 + int(char))
        time.sleep(0.04)


def everycafe_card_is_selected(x: int, y: int) -> bool:
    """Read Qt's blue selected-label marker without OCR or database writes."""
    user32 = ctypes.windll.user32
    desktop_dc = user32.GetDC(0)
    if not desktop_dc:
        return False
    selected_pixels = 0
    sampled_pixels = 0
    try:
        # The label band is 74..105 px below the monitor click centre. Sampling
        # every third pixel is enough to separate Qt's blue selection block
        # from white label glyphs on the normal dark background.
        for sample_y in range(y + 74, y + 106, 3):
            for sample_x in range(x - 58, x + 59, 3):
                color = int(user32.GetPixel(desktop_dc, sample_x, sample_y))
                if color == -1:
                    continue
                red = color & 0xFF
                green = (color >> 8) & 0xFF
                blue = (color >> 16) & 0xFF
                sampled_pixels += 1
                if blue > 100 and green > 60 and blue > red + 25:
                    selected_pixels += 1
    finally:
        user32.ReleaseDC(0, desktop_dc)
    return bool(sampled_pixels and selected_pixels / sampled_pixels >= 0.45)


def select_everycafe_card(hwnd: int, client_name: str) -> None:
    """Select the exact Qt card and prove its blue label before any command."""
    x, y = everycafe_card_point(hwnd, client_name)
    for click_y in (y, y + 92, y):
        activate_everycafe_window(hwnd)
        _mouse_click(x, click_y)
        deadline = time.monotonic() + 0.8
        while time.monotonic() < deadline:
            if everycafe_card_is_selected(x, y):
                return
            time.sleep(0.05)
    raise RuntimeError(f"{client_name} EveryCafe kartı seçilemedi; oturum komutu gönderilmedi.")


def invoke_everycafe_open(client_name: str, mode: str, minutes: int = 0):
    """Use EveryCafe's own UI/session engine. No DB write is performed here."""
    user32 = ctypes.windll.user32
    previous = user32.GetForegroundWindow()
    hwnd, was_visible = ensure_everycafe_window()
    try:
        select_everycafe_card(hwnd, client_name)
        if mode == "unlimited":
            _key(0x74)  # F5: MainClientContextMenu / Süresiz Aç
        elif mode == "timed":
            shortcut = {15: 0x31, 30: 0x32, 45: 0x33, 60: 0x34, 90: 0x35, 120: 0x36, 180: 0x37}[minutes]
            _key(shortcut, (0x11,))  # Ctrl+1..7 from EveryCafe's own menu metadata
        elif mode == "free":
            # ToolbarShortcuts OPENFREE=24: selected card + the existing star button.
            rect = wintypes.RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                raise RuntimeError("EveryCafe araç çubuğu konumu okunamadı.")
            dpi = user32.GetDpiForWindow(hwnd) if hasattr(user32, "GetDpiForWindow") else 96
            scale = max(0.75, float(dpi or 96) / 96.0)
            _mouse_click(int(rect.left + 836 * scale), int(rect.top + 119 * scale))
        time.sleep(0.45)
        _key(0x0D)  # EveryCafe'nin kendi onay penceresi
        time.sleep(0.55)
    finally:
        restore_window_after_automation(hwnd, previous, was_visible)


def invoke_everycafe_add_time(client_name: str, minutes: int):
    """Add custom minutes through EveryCafe's own active-session UI."""
    user32 = ctypes.windll.user32
    previous = user32.GetForegroundWindow()
    hwnd, was_visible = ensure_everycafe_window()
    try:
        select_everycafe_card(hwnd, client_name)
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise RuntimeError("EveryCafe pencere ölçüsü okunamadı.")
        dpi = user32.GetDpiForWindow(hwnd) if hasattr(user32, "GetDpiForWindow") else 96
        scale = max(0.75, float(dpi or 96) / 96.0)
        # Seçili aktif oturumun sol bilgi panelindeki EveryCafe "Süre Ekle" düğmesi.
        _mouse_click(int(rect.left + 63 * scale), int(rect.top + 670 * scale))
        time.sleep(0.35)
        # EveryCafe'nin "Süre Ekle/Çıkar" penceresindeki özel dakika alanı.
        _mouse_click(int(rect.left + 110 * scale), int(rect.top + 284 * scale))
        _key(0x41, (0x11,))  # Ctrl+A
        _type_digits(minutes)
        time.sleep(0.15)
        # Dakika alanının yanındaki yeşil uygulama işareti.
        _mouse_click(int(rect.left + 196 * scale), int(rect.top + 284 * scale))
        time.sleep(0.65)
    finally:
        restore_window_after_automation(hwnd, previous, was_visible)


def run_open_session(job_id: str, client_name: str, mode: str, minutes: int):
    lock = _client_session_locks.setdefault(client_name, threading.Lock())
    if not lock.acquire(blocking=False):
        return set_job(job_id, state="error", message="Bu masa için başka bir açılış işlemi sürüyor.")
    try:
        before = session_state(client_name)
        if before["active"] or before["queued"]:
            raise ValueError("Bu masada açık veya sırada bekleyen bir EveryCafe oturumu zaten var.")
        set_job(job_id, state="waking", message=f"{client_name} uyandırılıyor…")
        wake_client(client_name)
        wake_started = time.monotonic()
        open_not_before = wake_started + 40
        # EveryCafe bekleme ekranı yaklaşık 3 dakika sonra PC'yi kapatıyor.
        # Güvenli pay bırakarak 2:15 içinde oturumu başlat ya da açık hata ver.
        deadline = time.monotonic() + 135
        ready = False
        while time.monotonic() < deadline:
            state = session_state(client_name)
            reachable = bool(probe_reachable(state["clientIP"]))
            remaining = max(0, int(open_not_before - time.monotonic()))
            if remaining:
                set_job(job_id, message=f"{client_name} disksiz sistem hazırlanıyor… {remaining} sn")
            elif reachable and int(state.get("clientStatus") or 0) != 2:
                set_job(job_id, message=f"{client_name} ağda; EveryCafe Client bekleme durumu bekleniyor…")
            # Disksiz istemciler 45-60 saniyede hazır oluyor. WOL'den sonraki
            # 40. saniyeden önce deneme yapma. Ping tek başına yeterli değildir:
            # Qt kartı ancak EveryCafe ClientStatus=2 (Beklemede) olduğunda
            # seçilebilir. Aksi halde kısayol daha önce seçilmiş yanlış masaya gider.
            if reachable and int(state.get("clientStatus") or 0) == 2 and time.monotonic() >= open_not_before:
                ready = True
                break
            time.sleep(2)
        if not ready:
            raise TimeoutError("Bilgisayar açıldı ancak EveryCafe Client bekleme durumuna zamanında gelmedi.")
        for attempt in range(1, 4):
            set_job(job_id, state="opening", message=f"EveryCafe oturumu açılıyor ({attempt}/3)…")
            invoke_everycafe_open(client_name, mode, minutes)
            verify_deadline = time.monotonic() + 7
            while time.monotonic() < verify_deadline:
                proof = session_state(client_name)
                if proof["active"] or proof["queued"]:
                    return set_job(job_id, state="done", message=f"{client_name} EveryCafe oturumu açıldı.", proof=proof)
                time.sleep(0.7)
        raise RuntimeError("EveryCafe komutu uygulandı fakat oturum kaydı doğrulanamadı.")
    except Exception as exc:
        set_job(job_id, state="error", message=str(exc))
    finally:
        lock.release()


def create_session_job(client_name: str, mode: str, minutes: int) -> dict:
    if mode not in ALLOWED_SESSION_MODES:
        raise ValueError("Geçersiz oturum türü.")
    if mode == "timed" and minutes not in ALLOWED_TIMES:
        raise ValueError("Süre 15, 30, 45, 60, 90, 120 veya 180 dakika olmalıdır.")
    find_client(client_name)
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "client": client_name, "mode": mode, "minutes": minutes,
           "state": "queued", "message": "İşlem sıraya alındı.", "updatedAt": int(time.time() * 1000)}
    with _session_jobs_lock:
        _session_jobs[job_id] = job
    threading.Thread(target=run_open_session, args=(job_id, client_name, mode, minutes), daemon=True).start()
    return dict(job)


def run_add_time(job_id: str, client_name: str, minutes: int):
    lock = _client_session_locks.setdefault(client_name, threading.Lock())
    if not lock.acquire(blocking=False):
        return set_job(job_id, state="error", message="Bu masa için başka bir oturum işlemi sürüyor.")
    try:
        before = session_state(client_name)
        active = before.get("active")
        if not active:
            raise ValueError("Süre yalnızca açık EveryCafe oturumuna eklenebilir.")
        old_end = int(active.get("EndDate") or 0)
        session_id = str(active.get("SessionID") or "")
        set_job(job_id, state="opening", message=f"{client_name} oturumuna {minutes} dakika ekleniyor…")
        invoke_everycafe_add_time(client_name, minutes)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            proof = session_state(client_name)
            current = proof.get("active")
            if current and str(current.get("SessionID") or "") == session_id:
                new_end = int(current.get("EndDate") or 0)
                if new_end >= old_end + minutes * 60:
                    return set_job(
                        job_id,
                        state="done",
                        message=f"{client_name} oturumuna {minutes} dakika eklendi.",
                        proof=proof,
                    )
            time.sleep(0.5)
        raise RuntimeError("EveryCafe süre ekleme komutu uygulandı fakat yeni bitiş süresi doğrulanamadı.")
    except Exception as exc:
        set_job(job_id, state="error", message=str(exc))
    finally:
        lock.release()


def create_add_time_job(client_name: str, minutes: int) -> dict:
    if not 1 <= minutes <= MAX_ADDITIONAL_MINUTES:
        raise ValueError(f"Eklenecek süre 1-{MAX_ADDITIONAL_MINUTES} dakika arasında olmalıdır.")
    find_client(client_name)
    job_id = uuid.uuid4().hex
    job = {"id": job_id, "client": client_name, "mode": "add-time", "minutes": minutes,
           "state": "queued", "message": "Süre ekleme sıraya alındı.", "updatedAt": int(time.time() * 1000)}
    with _session_jobs_lock:
        _session_jobs[job_id] = job
    threading.Thread(target=run_add_time, args=(job_id, client_name, minutes), daemon=True).start()
    return dict(job)


PRO_EVENT_URL = "http://127.0.0.1:3000/admin/pro-event"

def emit_live_event(event_type: str, text: str) -> None:
    def _send():
        try:
            raw = json.dumps({"source":"Client Yönetim PRO","type":event_type,"text":text}, ensure_ascii=False).encode("utf-8")
            req = Request(PRO_EVENT_URL, data=raw, headers={"Content-Type":"application/json"}, method="POST")
            urlopen(req, timeout=1.2).read()
        except Exception:
            pass
    threading.Thread(target=_send, daemon=True).start()

class Handler(SimpleHTTPRequestHandler):
    server_version = "KafePinClientYonetimPRO/0.1"

    def log_message(self, *_args):
        pass

    def send_json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-KafePin-Client-Isolation", "separate-loopback-service")
        self.end_headers()
        self.wfile.write(body)

    def serve_file(self, relative: str):
        requested = (WEB / relative).resolve()
        if WEB not in requested.parents or not requested.is_file():
            return self.send_json({"ok": False, "error": "Bulunamadı"}, 404)
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
        }.get(requested.suffix, "application/octet-stream")
        body = requested.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-KafePin-Client-Isolation", "separate-loopback-service")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/api/health":
                return self.send_json({"ok": True, "app": "Client Yönetim PRO", "isolation": "separate-loopback-service", "everyCafeReadOnly": True})
            if path == "/api/clients":
                return self.send_json({"ok": True, "clients": list_clients(), "everyCafeReadOnly": True})
            if path.startswith("/api/session-job/"):
                job = get_job(path.rsplit("/", 1)[-1])
                return self.send_json({"ok": bool(job), "job": job, "error": None if job else "İş bulunamadı"}, 200 if job else 404)
            self.serve_file("index.html" if path in ("/", "/index.html") else path.lstrip("/"))
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 500)

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            size = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(size) or b"{}")
            if path == "/api/action":
                action = str(data.get("action") or "").strip().lower()
                client = str(data.get("client") or "").strip()
                if action not in ALLOWED_ACTIONS:
                    raise ValueError("Bu komut EveryCafe'nin gerçek komut biçimi doğrulanmadan etkinleştirilemez.")
                handlers = {
                    "wake": wake_client,
                    "restart": restart_client,
                    "terminate_apps": terminate_client_apps,
                }
                result = handlers[action](client)
                emit_live_event("client_action", f"{client} • {action} komutu tamamlandı")
                return self.send_json({"ok": True, "result": result})
            if path == "/api/open-session":
                client = str(data.get("client") or "").strip()
                mode = str(data.get("mode") or "").strip().lower()
                minutes = int(data.get("minutes") or 0)
                job = create_session_job(client, mode, minutes)
                emit_live_event("client_session", f"{client} • oturum açma kuyruğa alındı • {mode} • {minutes} dk")
                return self.send_json({"ok": True, "job": job}, 202)
            if path == "/api/add-time":
                client = str(data.get("client") or "").strip()
                minutes = int(data.get("minutes") or 0)
                job = create_add_time_job(client, minutes)
                emit_live_event("client_session", f"{client} • +{minutes} dk süre ekleme kuyruğa alındı")
                return self.send_json({"ok": True, "job": job}, 202)
            self.send_json({"ok": False, "error": "Bulunamadı"}, 404)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, 400)


if __name__ == "__main__":
    threading.Timer(1.0, lambda: emit_live_event("service", "Servis hazır • 17894 • EveryCafe salt-okunur")).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
