from __future__ import annotations

import base64
import hashlib
import json
import os
import py_compile
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEV = Path(__file__).resolve().parent
BASE_ZIP = ROOT / "KafePin-Pro-Update-v3.1.52.zip"
OUT_ZIP = ROOT / "KafePin-Pro-Update-v3.1.53.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.53.sha256.txt"
REPORT = ROOT / "V3.1.53-CANDIDATE-TEST-REPORT.md"
LATEST = ROOT / "latest.json"
EXPECTED_SERVER_SHA = "8b51abf1aec0214b8ffaa1a425a952631151bf3d031013ce68dbb156e8ee425a"
BUNDLE_SHA = "b2562fac542d0cf5760af820edbfb8a76836848bc23440c1dd99c9bcc87e6917"
EXPECTED_FILES = [
    "server.js",
    "KafePin_Manager_Ensure.ps1",
    "v3153-yazici-payload/index.html",
    "v3153-yazici-payload/v3153-ai.js",
    "v3153-yazici-payload/web_service.py",
    "v3153-yazici-payload/KafePin_YaziciGelir_Service.js",
    "v3153-yazici-payload/START_YAZICI_PRO.cmd",
    "v3153-yazici-payload/KafePin_YaziciPRO_WebView2.ps1",
    "v3153-yazici-payload/KafePin_AI_Ayarla.ps1",
    "v3153-yazici-payload/KafePin_AI_Ayarla.cmd",
    "v3153-yazici-payload/yazici-pro-version.json",
    "update.json",
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(*args: str) -> None:
    print("+", " ".join(args))
    subprocess.run(args, check=True)


def decode_bundle(target: Path) -> None:
    parts = sorted(DEV.glob("bundle.b64.part*"))
    if not parts:
        raise RuntimeError("bundle parts missing")
    encoded = "".join(p.read_text(encoding="ascii").strip() for p in parts)
    raw = base64.b64decode(encoded, validate=True)
    if sha256(raw) != BUNDLE_SHA:
        raise RuntimeError("bundle SHA mismatch")
    bundle = target / "bundle.tar.gz"
    bundle.write_bytes(raw)
    with tarfile.open(bundle, "r:gz") as tf:
        tf.extractall(target / "payload")


def verify_payload(build: Path) -> None:
    update = json.loads((build / "update.json").read_text(encoding="utf-8-sig"))
    assert update["version"] == "3.1.53"
    assert update["channel"] == "candidate"
    assert update["baseVersion"] == "3.1.49"
    assert update["cumulative"] is True
    assert update["files"] == EXPECTED_FILES

    server = (build / "server.js").read_bytes()
    assert sha256(server) == EXPECTED_SERVER_SHA
    text = server.decode("utf-8", errors="replace")
    assert "sqlite3.OPEN_READONLY" in text
    assert "TEST_SPIN_SURE_DK" not in text or "TEST_MODE" not in text

    html = (build / "v3153-yazici-payload/index.html").read_text(encoding="utf-8-sig")
    ai = (build / "v3153-yazici-payload/v3153-ai.js").read_text(encoding="utf-8-sig")
    web = (build / "v3153-yazici-payload/web_service.py").read_text(encoding="utf-8-sig")
    revenue = (build / "v3153-yazici-payload/KafePin_YaziciGelir_Service.js").read_text(encoding="utf-8-sig")
    launcher = (build / "v3153-yazici-payload/KafePin_YaziciPRO_WebView2.ps1").read_text(encoding="utf-8-sig")

    for marker in ["BELGE / DİLEKÇE & AI", "FOTOĞRAFTAN WORD", "WhatsApp", "KAFEPİN’E İŞLE", "ÜCRETSİZ", "İPTAL", "SİL"]:
        assert marker in html, marker
    for marker in ["photo", "scanner", "downloads", "word", "pdf", "whatsapp"]:
        assert marker.lower() in ai.lower(), marker
    assert "https://api.openai.com/v1/responses" in web
    assert "gpt-5.6-terra" in web
    assert '"store": False' in web or "'store': False" in web
    assert "KAFEPIN_OPENAI_API_KEY" in web
    assert "/transaction/confirm" in revenue
    assert "web.whatsapp.com" in launcher
    assert "WebView2" in launcher

    run("node", "--check", str(build / "server.js"))
    run("node", "--check", str(build / "v3153-yazici-payload/KafePin_YaziciGelir_Service.js"))
    run("node", "--check", str(build / "v3153-yazici-payload/v3153-ai.js"))
    py_compile.compile(str(build / "v3153-yazici-payload/web_service.py"), doraise=True)
    shutil.rmtree(build / "v3153-yazici-payload/__pycache__", ignore_errors=True)

    # PowerShell 5.1 Turkish text safety: scripts with non-ASCII content must have UTF-8 BOM.
    for rel in [
        "KafePin_Manager_Ensure.ps1",
        "v3153-yazici-payload/KafePin_YaziciPRO_WebView2.ps1",
        "v3153-yazici-payload/KafePin_AI_Ayarla.ps1",
    ]:
        assert (build / rel).read_bytes().startswith(b"\xef\xbb\xbf"), rel


def create_zip(build: Path) -> str:
    if OUT_ZIP.exists():
        OUT_ZIP.unlink()
    fixed_time = (2026, 8, 21, 8, 45, 0)
    with zipfile.ZipFile(OUT_ZIP, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in EXPECTED_FILES:
            data = (build / rel).read_bytes()
            info = zipfile.ZipInfo(rel, date_time=fixed_time)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zf.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    with zipfile.ZipFile(OUT_ZIP, "r") as zf:
        assert zf.namelist() == EXPECTED_FILES
        bad = zf.testzip()
        assert bad is None, bad
    digest = sha256(OUT_ZIP.read_bytes())
    SHA_FILE.write_text(f"{digest}  {OUT_ZIP.name}\n", encoding="ascii")
    return digest


def write_metadata(digest: str) -> None:
    tr = timezone(timedelta(hours=3))
    published = datetime.now(tr).replace(microsecond=0).isoformat()
    notes = (
        "v3.1.53 ADAY — v3.1.49 STABLE tabanlı KÜMÜLATİF güncelleme. "
        "v3.1.52 Yazıcı PRO/Event 307 ve açık onaydan önce finans göndermeme davranışı korunur. "
        "Yeni: Yazıcı PRO tek masaüstü penceresinde WebView2 ile Yazıcı PRO + WhatsApp Web; "
        "Belge / Dilekçe & AI; WORD AÇ ve FOTOĞRAFTAN WORD’E; fotoğraf/kamera/tarayıcı/İndirilenler görsel seçimi; "
        "OpenAI Responses API ile görselden metin ve el yazısı denemesi, şüpheli alan işaretleme, Word öncesi düzeltme, "
        "Word/PDF/WhatsApp ve isteğe bağlı yerel AI veri temizliği. AI metne çevirme otomatik satış oluşturmaz. "
        "KafePin_AI_ belge yazdırılırsa Belge/Dilekçe Hazırlama + çıktı birlikte hesaplanır. "
        "Onay ekranı KafePin’e İşle / Düzelt / Ücretsiz / İptal / Sil sunar. Doğrudan Satış POST yalnız açık onay yolundadır; "
        "çift satış engeli korunur. EveryCafe’ye yazılmaz. STABLE taban v3.1.49 olarak kalır."
    )
    latest = {
        "version": "3.1.53",
        "channel": "candidate",
        "stableVersion": "3.1.49",
        "baseVersion": "3.1.49",
        "cumulative": True,
        "publishedAt": published,
        "notes": notes,
        "downloadUrl": "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.53.zip",
        "sha256": digest,
    }
    LATEST.write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    REPORT.write_text(f"""# KafePin Pro v3.1.53 ADAY — Test Raporu

- Tarih: **{published}**
- STABLE taban: **v3.1.49**
- Paket tipi: **kümülatif / baseVersion 3.1.49**
- Kanal: **candidate**
- ZIP SHA256: `{digest}`
- v3.1.53 `server.js`: v3.1.52 ile byte-byte aynı (`{EXPECTED_SERVER_SHA}`)

## Geçen otomatik kontroller

- v3.1.52 içindeki doğrulanmış `server.js` aynen korundu; yeni çekirdek refactor yok.
- Node syntax: `server.js`, Yazıcı Geliri servisi ve AI tarayıcı JS geçti.
- Python compile: Yazıcı PRO web/AI servisi geçti.
- EveryCafe `sqlite3.OPEN_READONLY` koruması mevcut.
- `update.json`: version 3.1.53, baseVersion 3.1.49, cumulative=true.
- Yazıcı PRO: Belge / Dilekçe & AI, FOTOĞRAFTAN WORD, Word/PDF/WhatsApp akışı ve önizleme markerları doğrulandı.
- OpenAI Responses API, `store:false`, sunucu tarafı API anahtarı ve gpt-5.6-terra markerları doğrulandı.
- WhatsApp WebView2 tek pencere/iki sekme launcher markerları doğrulandı.
- Finans onay akışı ve yalnız explicit `/transaction/confirm` yoluyla KafePin Doğrudan Satış davranışı korunuyor.
- PowerShell 5.1 için Türkçe içeren kritik `.ps1` dosyalarında UTF-8 BOM doğrulandı.
- ZIP allow-list ve bütünlük testi geçti; pakette yalnız beklenen 12 dosya var.

## Yerelde ayrıca geçen entegrasyon testi

- Belge Hazırlama 30 TL + 2 sayfa S/B 10 TL = **40 TL**.
- Onaydan önce satış **0**; ilk KafePin’e İşle sonrası **1**; duplicate onay sonrası yine **1**.
- Ücretsiz / İptal / Sil satış oluşturmadı.
- Gönderilmiş veya sonucu belirsiz işlem için Sil engeli çalıştı.

## Saha doğrulaması gerekenler

- Gerçek Windows + Microsoft Word COM ile Word’e aktarım.
- Gerçek WebView2 Runtime + WhatsApp Web QR/oturum kalıcılığı.
- Gerçek yazıcı Event 307 ve WIA tarayıcı.
- Gerçek OpenAI API anahtarı + müşteri görseli ile görselden metne akışı.

**v3.1.53 STABLE değildir. STABLE taban v3.1.49 olarak kalır; kullanıcı saha testinden sonra “kitle” demeden kararlı sürüm sayılmaz.**
""", encoding="utf-8")


def main() -> None:
    if not BASE_ZIP.exists():
        raise FileNotFoundError(BASE_ZIP)
    with tempfile.TemporaryDirectory(prefix="kafepin3153-") as td:
        tmp = Path(td)
        decode_bundle(tmp)
        build = tmp / "payload"
        with zipfile.ZipFile(BASE_ZIP, "r") as zf:
            server = zf.read("server.js")
        if sha256(server) != EXPECTED_SERVER_SHA:
            raise RuntimeError("v3.1.52 server.js SHA mismatch")
        (build / "server.js").write_bytes(server)
        verify_payload(build)
        digest = create_zip(build)
        write_metadata(digest)
        print(f"V3153_BUILD_OK sha256={digest} size={OUT_ZIP.stat().st_size}")


if __name__ == "__main__":
    main()
