from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "3.1.64"
NEW_CAFE = ROOT / f"KafePin-Pro-Yeni-Kafe-FINAL-v{VERSION}.zip"
CLIENT = ROOT / f"KafePin-Client-v{VERSION}.zip"
SOURCE_CLIENT = ROOT / "KafePin-Client-v3.1.63.zip"
UPDATE = ROOT / f"KafePin-Pro-Update-v{VERSION}.zip"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def verify() -> None:
    require(NEW_CAFE.is_file(), f"Eksik: {NEW_CAFE.name}")
    require(CLIENT.is_file(), f"Eksik: {CLIENT.name}")

    with zipfile.ZipFile(NEW_CAFE) as outer:
        bad = outer.testzip()
        require(bad is None, f"Yeni kafe dış ZIP CRC hatası: {bad}")
        names = set(outer.namelist())
        main_name = f"KafePin-Pro-Ana-Sunucu-Kurulum-v{VERSION}.exe"
        client_name = f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe"
        for name in (main_name, client_name, "KURULUMU_BASLAT.cmd", "kurulum.json", "SHA256SUMS.txt"):
            require(name in names, f"Yeni kafe dış paketi eksik: {name}")
        main_bytes = outer.read(main_name)
        embedded_client = outer.read(client_name)
        meta = json.loads(outer.read("kurulum.json").decode("utf-8-sig"))
        require(meta["version"] == VERSION and meta["offline"] is True, "Yeni kafe dış metadata hatalı")
        require(meta["mainInstallerSha256"] == digest(main_bytes), "Ana EXE SHA metadata hatalı")
        require(meta["clientInstallerSha256"] == digest(embedded_client), "Client EXE SHA metadata hatalı")

    with zipfile.ZipFile(io.BytesIO(main_bytes)) as installer:
        bad = installer.testzip()
        require(bad is None, f"Ana EXE gömülü ZIP CRC hatası: {bad}")
        names = set(installer.namelist())
        required = {
            "server/server.js",
            "server/public/admin.html",
            "server/desktop-app/KafePinProDesktop.cs",
            "server/KafePin_Pro_Bilesen_Kurulum.ps1",
            "server/pro-components/mp3-bot-pro.zip",
            "server/pro-components/yazici-pro.zip",
            "server/pro-components/teknik-servis-pro.zip",
            "server/pro-components/client-yonetim-pro.zip",
            "KafePin-Pro-Yeni-Kafe-Kur.ps1",
            "KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1",
            "kurulum-manifest.json",
        }
        require(required.issubset(names), f"Ana EXE eksikleri: {sorted(required - names)}")
        manifest = json.loads(installer.read("kurulum-manifest.json").decode("utf-8-sig"))
        require(manifest["version"] == VERSION, "Gömülü manifest sürümü hatalı")
        listed = {row["path"]: row for row in manifest["files"]}
        require(manifest["fileCount"] == len(listed), "Gömülü manifest fileCount hatalı")
        for name, row in listed.items():
            data = installer.read(name)
            require(len(data) == row["size"], f"Boyut hatası: {name}")
            require(digest(data) == row["sha256"], f"SHA hatası: {name}")
        for script in ("KafePin-Pro-Yeni-Kafe-Kur.ps1", "KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1"):
            text = installer.read(script).decode("utf-8-sig")
            require("$BaseVersion='3.1.64'" in text, f"{script} v3.1.64 tabanı değil")
            require("KafePin Pro v3.1.64 FINAL / STABLE — tam kurulum" in text, f"{script} başlığı hatalı")
            require("-ProRoot 'C:\\KafePinPro' -InitialSetup" in text, f"{script} PRO seçim çağrısı yok")
            require("-EveryCafeEnabled" in text, f"{script} EveryCafe/Client PRO kuralı yok")
            require("Telegram bot token" in text and "'TELEGRAM_ENABLED='+" in text, f"{script} Telegram kurulumu eksik")
            stable_check = text.index("githubusercontent.com/omurtopal33/Kafepin-Pro/main/latest.json")
            component_setup = text.index("Write-Step 'İsteğe bağlı PRO bileşenleri'")
            node_setup = text.index("Write-Step 'Node.js x64 runtime'")
            require(stable_check < component_setup < node_setup, f"{script} STABLE/PRO kurulum sırası hatalı")
            require("latest-test.json" not in text, f"{script} TEST kanalına bağlanıyor")
        component = installer.read("server/KafePin_Pro_Bilesen_Kurulum.ps1").decode("utf-8-sig")
        for expected in ("C:\\KafePinPro", "MP3BotPRO", "YaziciPRO", "TeknikServisPRO", "ClientYonetimPRO"):
            require(expected in component, f"PRO hedefi eksik: {expected}")
        require("[switch]$EveryCafeEnabled" in component, "Client PRO EveryCafe koşulu eksik")
        require("if ($EveryCafeEnabled)" in component, "Client PRO EveryCafe seçimi koşullu değil")
        require("C:\\KafePinPRO" not in component, "Eski PRO kökü kaldı")

        with zipfile.ZipFile(UPDATE) as update:
            info = json.loads(update.read("update.json").decode("utf-8-sig"))
            for rel in info["files"]:
                if rel == "KafePin_Pro_Bilesen_Kurulum.ps1":
                    continue
                require(installer.read("server/" + rel) == update.read(rel), f"v3.1.64 payload eşleşmiyor: {rel}")
            for rel in ("server.js", "services/spinService.js", "utils/fee.js", "public/monitor.html"):
                require(installer.read("server/" + rel) == update.read(rel), f"Korunan çekirdek eşleşmiyor: {rel}")
        for component_zip in (
            "server/pro-components/mp3-bot-pro.zip",
            "server/pro-components/yazici-pro.zip",
            "server/pro-components/teknik-servis-pro.zip",
            "server/pro-components/client-yonetim-pro.zip",
        ):
            with zipfile.ZipFile(io.BytesIO(installer.read(component_zip))) as nested:
                require(nested.testzip() is None, f"Bileşen ZIP CRC hatası: {component_zip}")

    with zipfile.ZipFile(CLIENT) as client, zipfile.ZipFile(SOURCE_CLIENT) as source:
        require(client.testzip() is None, "Client v3.1.64 ZIP CRC hatası")
        require(client.read("KafePin-Pro-Client-Kurulum.exe") == source.read("KafePin-Pro-Client-Kurulum.exe"), "Client EXE değişmiş")
        meta = json.loads(client.read("client-version.json").decode("utf-8-sig"))
        require(meta["version"] == VERSION and meta["protocolChanged"] is False, "Client metadata hatalı")

    print(
        "V3164_NEW_CAFE_VERIFY_OK",
        f"newCafeSha={digest(NEW_CAFE.read_bytes())}",
        f"clientSha={digest(CLIENT.read_bytes())}",
    )


if __name__ == "__main__":
    verify()
