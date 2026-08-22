from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "3.1.64"
SOURCE_NEW_CAFE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
SOURCE_UPDATE = ROOT / "KafePin-Pro-Update-v3.1.64.zip"
SOURCE_CLIENT = ROOT / "KafePin-Client-v3.1.63.zip"
OUT_NEW_CAFE = ROOT / f"KafePin-Pro-Yeni-Kafe-FINAL-v{VERSION}.zip"
OUT_CLIENT = ROOT / f"KafePin-Client-v{VERSION}.zip"
OUT_NEW_CAFE_SHA = ROOT / f"KafePin-Pro-Yeni-Kafe-FINAL-v{VERSION}.sha256.txt"
OUT_CLIENT_SHA = ROOT / f"KafePin-Client-v{VERSION}.sha256.txt"

ZIP_DATE = (2026, 8, 22, 12, 0, 0)
BUILD_TEMP_ROOT = ROOT / ".build-v3164-new-cafe-fixed"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def zip_tree(source: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(source.rglob("*"), key=lambda p: p.relative_to(source).as_posix().lower()):
            if not path.is_file():
                continue
            rel = path.relative_to(source).as_posix()
            info = zipfile.ZipInfo(rel, ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def replace_required(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count < 1:
        raise RuntimeError(f"{label}: beklenen metin bulunamadı: {old!r}")
    return text.replace(old, new)


def patch_install_script(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    text = replace_required(text, "$BaseVersion='3.1.29'", "$BaseVersion='3.1.64'", path.name)
    text = replace_required(
        text,
        "$InstallerBuild='2026.08.20-STABLE-349-BASE-329'",
        "$InstallerBuild='2026.08.22-FINAL-3164-OFFLINE'",
        path.name,
    )
    validation_marker = "if($masaCount -lt 1"
    if validation_marker not in text:
        raise RuntimeError(f"{path.name}: Telegram ekleme noktası bulunamadı")
    if "$NonInteractive" in text:
        telegram_block = r"""if($NonInteractive){
  $telegramEnabled=$false;$telegramToken='';$telegramChatId=''
}else{
  $telegramEnabled=Ask-Yes 'Telegram sağlık ve gün sonu bildirimleri etkinleştirilsin mi?' $false
  $telegramToken='';$telegramChatId=''
  if($telegramEnabled){
    $telegramToken=Ask 'Telegram bot token' ''
    $telegramChatId=Ask 'Telegram chat ID' ''
    if([string]::IsNullOrWhiteSpace($telegramToken) -or [string]::IsNullOrWhiteSpace($telegramChatId)){throw 'Telegram etkinse bot token ve chat ID zorunludur.'}
  }
}
"""
    else:
        telegram_block = r"""$telegramEnabled=Ask-Yes 'Telegram sağlık ve gün sonu bildirimleri etkinleştirilsin mi?' $false
$telegramToken='';$telegramChatId=''
if($telegramEnabled){
  $telegramToken=Ask 'Telegram bot token' ''
  $telegramChatId=Ask 'Telegram chat ID' ''
  if([string]::IsNullOrWhiteSpace($telegramToken) -or [string]::IsNullOrWhiteSpace($telegramChatId)){throw 'Telegram etkinse bot token ve chat ID zorunludur.'}
}
"""
    text = text.replace(validation_marker, telegram_block + validation_marker, 1)
    text = replace_required(
        text,
        "  'TELEGRAM_ENABLED=0',\n  'TELEGRAM_BOT_TOKEN=',\n  'TELEGRAM_CHAT_ID='",
        "  'TELEGRAM_ENABLED='+$(if($telegramEnabled){'1'}else{'0'}),\n  'TELEGRAM_BOT_TOKEN='+$telegramToken,\n  'TELEGRAM_CHAT_ID='+$telegramChatId",
        path.name,
    )
    text = replace_required(
        text,
        "KafePin Pro v3.1.49 STABLE — kurulum tabanı v3.1.29",
        "KafePin Pro v3.1.64 FINAL / STABLE — tam kurulum",
        path.name,
    )
    # Önce STABLE kanal güncellemesi uygulanır; böylece yeni kafede seçilecek
    # PRO bileşenleri de varsa gelecekteki en son kararlı paketlerden kurulur.
    marker = "Write-Step 'Node.js x64 runtime'"
    component_block = r"""Write-Step 'İsteğe bağlı PRO bileşenleri'
$componentInstaller=Join-Path $InstallRoot 'KafePin_Pro_Bilesen_Kurulum.ps1'
if(Test-Path -LiteralPath $componentInstaller){
  try{
    if($useEc){
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $componentInstaller -InstallRoot $InstallRoot -ProRoot 'C:\KafePinPro' -InitialSetup -EveryCafeEnabled
    }else{
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $componentInstaller -InstallRoot $InstallRoot -ProRoot 'C:\KafePinPro' -InitialSetup
    }
    if($LASTEXITCODE -ne 0){Write-Warning ('PRO bileşen kurucusu çıkış kodu: '+$LASTEXITCODE)}
  }catch{Write-Warning ('PRO bileşen seçimi tamamlanamadı; çekirdek kurulum devam ediyor. '+$_.Exception.Message)}
}

"""
    if marker not in text:
        raise RuntimeError(f"{path.name}: PRO bileşen ekleme noktası bulunamadı")
    text = text.replace(marker, component_block + marker, 1)
    path.write_text(text, encoding="utf-8-sig", newline="\r\n")


def patch_component_installer(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    replacements = {
        "[string]$ProRoot = 'C:\\KafePinPRO'": "[string]$ProRoot = 'C:\\KafePinPro'",
        "Join-Path $ProRoot 'MP3Bot'": "Join-Path $ProRoot 'MP3BotPRO'",
        "Join-Path $ProRoot 'Yazici'": "Join-Path $ProRoot 'YaziciPRO'",
        "Join-Path $ProRoot 'TeknikServis'": "Join-Path $ProRoot 'TeknikServisPRO'",
        "Join-Path $ProRoot 'ClientYonetim'": "Join-Path $ProRoot 'ClientYonetimPRO'",
        "version = '3.1.60'": "version = '3.1.64'",
    }
    for old, new in replacements.items():
        text = replace_required(text, old, new, path.name)
    text = replace_required(
        text,
        "[switch]$InitialSetup\n)",
        "[switch]$InitialSetup,\n  [switch]$EveryCafeEnabled\n)",
        path.name,
    )
    old_choice = "  client = Ask-Component 'KafePin Client Yönetim PRO' 'Client Yönetim PRO kurulsun mu?`n`nCanlı masa durumunu salt okunur gösterir; uyandırma, yeniden başlatma, süreli/süresiz/ücretsiz oturum açma, açık oturuma süre ekleme ve onaylı çalışan uygulamaları sonlandırma araçlarını sağlar. Bilgisayar/hesap/masa kapatma ve tahsilat yapmaz.'"
    new_choice = "  client = $(if ($EveryCafeEnabled) { Ask-Component 'KafePin Client Yönetim PRO' 'Client Yönetim PRO kurulsun mu?`n`nCanlı masa durumunu salt okunur gösterir; uyandırma, yeniden başlatma, süreli/süresiz/ücretsiz oturum açma, açık oturuma süre ekleme ve onaylı çalışan uygulamaları sonlandırma araçlarını sağlar. Bilgisayar/hesap/masa kapatma ve tahsilat yapmaz.' } else { $false })"
    text = replace_required(text, old_choice, new_choice, path.name)
    path.write_text(text, encoding="utf-8-sig", newline="\r\n")


def build_manifest(payload: Path) -> None:
    files = []
    for path in sorted(payload.rglob("*"), key=lambda p: p.relative_to(payload).as_posix().lower()):
        if not path.is_file() or path.name == "kurulum-manifest.json":
            continue
        files.append(
            {
                "path": path.relative_to(payload).as_posix(),
                "size": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    manifest = {
        "version": VERSION,
        "type": "new-cafe-full-installer-final-offline",
        "installerBuild": "2026.08.22-FINAL-3164-OFFLINE",
        "createdFor": "KafePin Pro Yeni Kafe",
        "fileCount": len(files),
        "files": files,
    }
    (payload / "kurulum-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def build_sfx(source_exe: Path, payload: Path, output: Path) -> None:
    with zipfile.ZipFile(source_exe) as archive:
        prefix_size = min(item.header_offset for item in archive.infolist())
    prefix = source_exe.read_bytes()[:prefix_size]
    if prefix.count(b"v3.1.29") != 2:
        raise RuntimeError("Ana kurucu başlığındaki v3.1.29 işaretleri beklenen sayıda değil")
    prefix = prefix.replace(b"v3.1.29", b"v3.1.64")
    archive_path = BUILD_TEMP_ROOT / "installer-payload.zip"
    zip_tree(payload, archive_path)
    output.write_bytes(prefix + archive_path.read_bytes())


def build() -> None:
    for required in (SOURCE_NEW_CAFE, SOURCE_UPDATE, SOURCE_CLIENT):
        if not required.is_file():
            raise FileNotFoundError(required)

    if BUILD_TEMP_ROOT.exists():
        shutil.rmtree(BUILD_TEMP_ROOT)
    BUILD_TEMP_ROOT.mkdir(parents=True)
    try:
        temp = BUILD_TEMP_ROOT
        old_outer = temp / "old-outer"
        update = temp / "update"
        payload = temp / "installer-payload"
        new_outer = temp / "new-outer"
        client_outer = temp / "client-outer"
        old_outer.mkdir()
        update.mkdir()
        payload.mkdir()
        new_outer.mkdir()
        client_outer.mkdir()

        with zipfile.ZipFile(SOURCE_NEW_CAFE) as archive:
            archive.extractall(old_outer)
        with zipfile.ZipFile(SOURCE_UPDATE) as archive:
            archive.extractall(update)
        source_exe = old_outer / "KafePin-Pro-Ana-Sunucu-Kurulum.exe"
        with zipfile.ZipFile(source_exe) as archive:
            archive.extractall(payload)

        update_info = json.loads((update / "update.json").read_text(encoding="utf-8-sig"))
        if update_info.get("version") != VERSION:
            raise RuntimeError("v3.1.64 update manifesti doğrulanamadı")
        for rel in update_info["files"]:
            src = update / rel
            dst = payload / "server" / rel
            if not src.is_file():
                raise FileNotFoundError(src)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

        client_exe = old_outer / "KafePin-Pro-Client-Kurulum.exe"
        shutil.copy2(client_exe, payload / "server" / "Client-Kurulum" / client_exe.name)
        shutil.copy2(client_exe, payload / "Diskless-Client-Paketi" / client_exe.name)

        patch_component_installer(payload / "server" / "KafePin_Pro_Bilesen_Kurulum.ps1")
        patch_install_script(payload / "KafePin-Pro-Yeni-Kafe-Kur.ps1")
        patch_install_script(payload / "KafePin-Pro-Yeni-Kafe-Kur-GUI.ps1")

        (payload / "OKU-BENI.txt").write_text(
            """KAFEPIN PRO - YENI KAFE FINAL TAM KURULUM v3.1.64
=====================================================

Bu kurucu KafePin Pro v3.1.64 FINAL / STABLE sürümünü internetten güncelleme beklemeden doğrudan kurar.
Kurulum CMD penceresinde ilerler ve işletme/masa/EveryCafe/yedek ayarlarını sorar.
EveryCafe veritabanı yalnız salt okunur kullanılır.

Kurulum sırasında ayrıca şu bağımsız bileşenler ayrı ayrı sorulur:
- MP3 Bot PRO       -> C:\\KafePinPro\\MP3BotPRO
- Yazıcı PRO        -> C:\\KafePinPro\\YaziciPRO
- Teknik Servis PRO -> C:\\KafePinPro\\TeknikServisPRO
- Client Yönetim PRO-> C:\\KafePinPro\\ClientYonetimPRO

Client Yönetim PRO yalnız EveryCafe kullanılan kafelerde sorulur ve kurulabilir.

Ana çekirdek C:\\KafePin altında kalır. PRO bileşenleri çekirdeğe karışmaz.
Kurulumdan sonra masaüstündeki KafePin Pro kısayolundan açılır.
""",
            encoding="utf-8",
        )
        (payload / "yeni-kafe-version.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "channel": "stable",
                    "finalStable": True,
                    "offlinePayloadVersion": VERSION,
                    "clientPackageVersion": VERSION,
                    "installerBuild": "2026.08.22-FINAL-3164-OFFLINE",
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        build_manifest(payload)

        new_exe = new_outer / f"KafePin-Pro-Ana-Sunucu-Kurulum-v{VERSION}.exe"
        build_sfx(source_exe, payload, new_exe)
        shutil.copy2(client_exe, new_outer / f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe")
        (new_outer / "KURULUMU_BASLAT.cmd").write_text(
            "@echo off\r\nchcp 65001 >nul\r\ntitle KafePin Pro v3.1.64 FINAL Yeni Kafe Kurulumu\r\n"
            f"\"%~dp0KafePin-Pro-Ana-Sunucu-Kurulum-v{VERSION}.exe\"\r\n"
            "set RC=%ERRORLEVEL%\r\nif not \"%RC%\"==\"0\" pause\r\nexit /b %RC%\r\n",
            encoding="utf-8",
        )
        (new_outer / "VERSIYON.txt").write_text(
            "KafePin Pro v3.1.64 FINAL / STABLE\nYeni kafe çevrimdışı tam kurulum\n",
            encoding="utf-8",
        )
        (new_outer / "OKU-BENI.txt").write_text((payload / "OKU-BENI.txt").read_text(encoding="utf-8"), encoding="utf-8")
        hashes = {
            new_exe.name: sha256(new_exe),
            f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe": sha256(new_outer / f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe"),
        }
        (new_outer / "SHA256SUMS.txt").write_text(
            "".join(f"{digest}  {name}\n" for name, digest in hashes.items()), encoding="ascii"
        )
        (new_outer / "kurulum.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "channel": "stable",
                    "finalStable": True,
                    "offline": True,
                    "mainInstaller": new_exe.name,
                    "clientInstaller": f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe",
                    "mainInstallerSha256": hashes[new_exe.name],
                    "clientInstallerSha256": hashes[f"KafePin-Pro-Client-Kurulum-v{VERSION}.exe"],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        zip_tree(new_outer, OUT_NEW_CAFE)

        shutil.copy2(client_exe, client_outer / "KafePin-Pro-Client-Kurulum.exe")
        (client_outer / "CLIENT-OKU-BENI.txt").write_text(
            "KafePin Client v3.1.64\n"
            "KafePin Pro v3.1.64 FINAL ana sunucuyla uyumludur.\n"
            "Client protokolü değişmediği için doğrulanmış v3.1.63 kurucu ikilisi aynen korunmuştur.\n",
            encoding="utf-8",
        )
        (client_outer / "client-version.json").write_text(
            json.dumps(
                {
                    "version": VERSION,
                    "serverCompatibility": VERSION,
                    "installerSha256": sha256(client_outer / "KafePin-Pro-Client-Kurulum.exe"),
                    "protocolChanged": False,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        zip_tree(client_outer, OUT_CLIENT)
    finally:
        shutil.rmtree(BUILD_TEMP_ROOT, ignore_errors=True)

    OUT_NEW_CAFE_SHA.write_text(f"{sha256(OUT_NEW_CAFE)}  {OUT_NEW_CAFE.name}\n", encoding="ascii")
    OUT_CLIENT_SHA.write_text(f"{sha256(OUT_CLIENT)}  {OUT_CLIENT.name}\n", encoding="ascii")
    print(f"NEW_CAFE={OUT_NEW_CAFE} SHA256={sha256(OUT_NEW_CAFE)}")
    print(f"CLIENT={OUT_CLIENT} SHA256={sha256(OUT_CLIENT)}")


if __name__ == "__main__":
    build()
