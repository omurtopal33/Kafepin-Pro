from __future__ import annotations

import hashlib
import json
import shutil
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LIVE = Path(r"C:\KafePin")
UPDATE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
NEW_CAFE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.60.sha256.txt"
STAMP = (2026, 8, 22, 12, 0, 0)
NOTES = (
    "v3.1.60 FINAL / STABLE — kilitli yeni kafe ve güncelleme referansıdır. "
    "Sonraki tüm sürümler v3.1.60 üzerine kümülatif güncelleme olarak yayınlanır. "
    "Yeni kafe kurulumu EveryCafe (salt-okunur DB yolu), masa sayısı, yedek klasörü "
    "ve isteğe bağlı Telegram ayarlarını sorar; ardından MP3 Bot PRO, Yazıcı PRO, "
    "Teknik Servis PRO ve Client Yönetim PRO ayrı ayrı sorulur. EveryCafe veritabanına "
    "SQL yazılmaz; hesap/masa kapatma ve tahsilat yapılmaz. KafePin ücret, spin, "
    "session, finans, Telegram sağlık raporu ve 20:00 gün sonu mantığı korunmuştur."
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def unpack(archive: Path, target: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        source.extractall(target)


def pack(source: Path, archive: Path) -> None:
    temp = archive.with_suffix(".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for file in sorted(path for path in source.rglob("*") if path.is_file()):
            item = zipfile.ZipInfo(file.relative_to(source).as_posix(), STAMP)
            item.compress_type = zipfile.ZIP_DEFLATED
            item.external_attr = 0o644 << 16
            output.writestr(item, file.read_bytes())
    temp.replace(archive)


def metadata(stage: Path) -> dict:
    return {
        "version": "3.1.60",
        "channel": "stable",
        "finalStable": True,
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "publishedAt": "2026-08-22T12:00:00+03:00",
        "notes": NOTES,
        "files": sorted(path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file()),
    }


def write_metadata(stage: Path) -> None:
    data = json.dumps(metadata(stage), ensure_ascii=False, indent=2) + "\n"
    for name in ("update.json", "kafepin-pro-version.json"):
        (stage / name).write_text(data, encoding="utf-8")


def main() -> None:
    for required in (UPDATE, NEW_CAFE, LIVE / "KafePin_Desktop_App_Setup.ps1", LIVE / "KafePin_Pro_Bilesen_Kurulum.ps1", LIVE / "KafePin_Yeni_Kafe_Ayar_Sihirbazi.ps1"):
        if not required.is_file():
            raise SystemExit(f"Missing required input: {required}")
    work_root = ROOT / "dev" / "_finalize-work"
    if work_root.exists():
        shutil.rmtree(work_root)
    work_root.mkdir(parents=True)
    try:
        update = work_root / "update"
        unpack(UPDATE, update)
        for name in ("KafePin_Desktop_App_Setup.ps1", "KafePin_Pro_Bilesen_Kurulum.ps1", "KafePin_Yeni_Kafe_Ayar_Sihirbazi.ps1"):
            shutil.copy2(LIVE / name, update / name)
        write_metadata(update)
        pack(update, UPDATE)

        new_cafe = work_root / "new-cafe"
        unpack(NEW_CAFE, new_cafe)
        for name in ("KafePin_Desktop_App_Setup.ps1", "KafePin_Pro_Bilesen_Kurulum.ps1", "KafePin_Yeni_Kafe_Ayar_Sihirbazi.ps1"):
            shutil.copy2(LIVE / name, new_cafe / name)
        (new_cafe / "VERSIYON.txt").write_text("KafePin Pro v3.1.60 FINAL / STABLE\n", encoding="utf-8-sig")
        (new_cafe / "OKU-BENI.txt").write_text(
            "KAFEPIN PRO YENİ KAFE KURULUMU\n"
            "================================\n\n"
            "Bu paket KafePin Pro v3.1.60 FINAL / STABLE sürümünü doğrudan kurar.\n"
            "Sonraki sürümler bu kurulumun üzerine kümülatif güncelleme olarak uygulanır.\n\n"
            "Kurulum önce şu bilgileri sorar:\n"
            "- EveryCafe kullanımı ve varsa ecmdata.ecm salt-okunur bağlantı yolu\n"
            "- Toplam masa/bilgisayar sayısı\n"
            "- Otomatik yedek klasörü\n"
            "- İsteğe bağlı Telegram bot token ve chat ID\n\n"
            "Ardından aşağıdaki bağımsız PRO bileşenleri ayrı ayrı sorulur:\n"
            "- MP3 Bot PRO\n- Yazıcı PRO\n- Teknik Servis PRO\n- Client Yönetim PRO\n\n"
            "EveryCafe veritabanı yalnız salt-okunur kullanılır; hesap/masa kapatma veya tahsilat yapılmaz.\n",
            encoding="utf-8-sig",
        )
        write_metadata(new_cafe)
        pack(new_cafe, NEW_CAFE)
    finally:
        if work_root.exists():
            shutil.rmtree(work_root)

    digest = sha256(UPDATE)
    SHA_FILE.write_text(f"{digest}  {UPDATE.name}\n", encoding="utf-8")
    latest = {
        "version": "3.1.60",
        "channel": "stable",
        "finalStable": True,
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "publishedAt": "2026-08-22T12:00:00+03:00",
        "notes": NOTES,
        "downloadUrl": "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.60.zip",
        "sha256": digest,
    }
    (ROOT / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("FINAL_V3160_OK", digest)


if __name__ == "__main__":
    main()
