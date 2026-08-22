from __future__ import annotations

import hashlib
import json
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
NEW_CAFE_BASE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.62.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.62.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.62.zip"
REPORT = ROOT / "RELEASE_NOTES-v3.1.62.md"
FIXED_DT = (2026, 8, 22, 16, 0, 0)
VERSION = "3.1.62"

# v3.1.62 MUST remain visually/functionally identical to the locked v3.1.60
# FINAL package. Only the legacy Manager payload blocker and version metadata
# are allowed to differ in the update ZIP.
ALLOWED_CHANGED_FILES = {
    "KafePin_Manager_Ensure.ps1",
    "update.json",
    "kafepin-pro-version.json",
}

NOTES = (
    "v3.1.62 STABLE kümülatif onarım: doğrudan kilitli v3.1.60 FINAL paketinden üretilir. "
    "v3.1.60'taki masaüstü arayüzü, kartlar, PRO Servisleri Yenile, MP3 Bot PRO, Yazıcı PRO, "
    "Teknik Servis PRO, yönetim ekranları ve çekirdek davranışlar byte-for-byte korunur. Yalnız eski "
    "v3.1.57 Yazıcı payload zorunluluğunun Server Manager hazırlığını durdurması kaldırılır ve sürüm "
    "metadata'sı 3.1.62 yapılır. Finans, spin, session, EveryCafe read-only, Telegram ve 20:00 işletme "
    "günü mantığı değiştirilmez."
)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def file_sha_map(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): sha256(p)
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def pack_tree(root: Path, out: Path) -> None:
    if out.exists():
        out.unlink()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(x for x in root.rglob("*") if x.is_file()):
            rel = p.relative_to(root).as_posix()
            zi = zipfile.ZipInfo(rel, FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, p.read_bytes())


def contains_marker(root: Path, marker: str) -> bool:
    needle = marker.casefold()
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".cs", ".html", ".js", ".ps1", ".cmd", ".txt", ".json"}:
            continue
        try:
            text = p.read_text(encoding="utf-8-sig", errors="ignore")
        except Exception:
            continue
        if needle in text.casefold():
            return True
    return False


def validate_v3160_identity_markers(work: Path) -> None:
    required = [
        "PRO Servisleri Yenile",
        "MP3 Bot PRO",
        "Yazıcı PRO",
        "Teknik Servis PRO",
    ]
    missing = [m for m in required if not contains_marker(work, m)]
    if missing:
        raise SystemExit("v3.1.60 FINAL identity marker missing: " + ", ".join(missing))

    server = work / "server.js"
    if not server.is_file():
        raise SystemExit("server.js missing from v3.1.60 FINAL")
    server_text = server.read_text(encoding="utf-8-sig", errors="ignore")
    if "available: compareProVersions(remote.version, current) > 0" not in server_text:
        raise SystemExit("v3.1.60 safe update equality guard missing")


def patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # v3.1.57 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi."
    end_marker = "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }"
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start < 0 or end < 0 or end <= start:
        raise SystemExit("legacy Manager Yazici block markers not found in v3.1.60")

    replacement = r'''  # v3.1.62: v3.1.60 FINAL arayuz/bilesenleri aynen korunur.
  # Eski v3.1.57 Yazici payload'i artik Server Manager icin zorunlu degildir.
  # Desktop kurulumu v3.1.60 FINAL paketindeki KENDI setup scriptiyle yapilir;
  # AppVersion override verilmez, boylece v3.1.60'taki son UI/kartlar aynen kullanilir.
  Log 'v3.1.62: legacy Yazici payload zorunlulugu atlandi; v3.1.60 FINAL desktop korunuyor.'
  $desktopSetup = Join-Path $InstallRoot 'KafePin_Desktop_App_Setup.ps1'
  if (-not (Test-Path -LiteralPath $desktopSetup -PathType Leaf)) { throw 'KafePin_Desktop_App_Setup.ps1 bulunamadi.' }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $desktopSetup -InstallRoot $InstallRoot
  if ($LASTEXITCODE -ne 0) { throw ('KafePin ana masaustu uygulamasi guncellenemedi. Cikis=' + $LASTEXITCODE) }
  Log 'KafePin ana masaustu uygulamasi v3.1.60 FINAL kaynaklariyla hazir.'
'''
    text = text[:start] + replacement + text[end:]

    if "v3.1.57 Yazici payload klasoru bulunamadi" in text:
        raise SystemExit("legacy fatal Yazici payload check survived")
    if "KafePin_Desktop_App_Setup.ps1" not in text:
        raise SystemExit("desktop setup invocation missing after Manager patch")
    path.write_text(text, encoding="utf-8-sig")


def write_metadata(work: Path) -> None:
    meta = {
        "version": VERSION,
        "channel": "candidate",
        "stableBase": "3.1.60",
        "baseVersion": "3.1.60",
        "previousStable": "3.1.61",
        "futureUpdateBase": "3.1.60",
        "cumulative": True,
        "v3160ExactUiPreserved": True,
        "publishedAt": "2026-08-22T16:00:00+03:00",
        "notes": NOTES,
    }
    meta["files"] = sorted(p.relative_to(work).as_posix() for p in work.rglob("*") if p.is_file())
    data = json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    for name in ("update.json", "kafepin-pro-version.json"):
        (work / name).write_text(data, encoding="utf-8")


def verify_only_allowed_changes(before: dict[str, str], after: dict[str, str]) -> None:
    before_files = set(before)
    after_files = set(after)
    if before_files != after_files:
        added = sorted(after_files - before_files)
        removed = sorted(before_files - after_files)
        raise SystemExit(f"v3.1.60 file set changed; added={added}, removed={removed}")

    changed = {name for name in before_files if before[name] != after[name]}
    unexpected = sorted(changed - ALLOWED_CHANGED_FILES)
    required_changed = sorted(ALLOWED_CHANGED_FILES - changed)
    if unexpected:
        raise SystemExit("unexpected v3.1.60 file changes: " + ", ".join(unexpected))
    if required_changed:
        raise SystemExit("expected patched files did not change: " + ", ".join(required_changed))


def build_client_from_v3160() -> list[str]:
    if not NEW_CAFE_BASE.exists():
        raise SystemExit("v3.1.60 FINAL new-cafe base package missing")

    runtime_ext = (".exe", ".ps1", ".cmd", ".bat", ".json", ".dll", ".config")
    selected: list[str] = []
    with zipfile.ZipFile(NEW_CAFE_BASE, "r") as src:
        for name in src.namelist():
            low = name.lower()
            if low.endswith("/"):
                continue
            if ("client" in low and low.endswith(runtime_ext)) or ("masa" in low and low.endswith(runtime_ext)):
                selected.append(name)

        selected = sorted(set(selected))
        if not selected:
            raise SystemExit("no client runtime artifacts found in v3.1.60 FINAL new-cafe package")

        if CLIENT_OUT.exists():
            CLIENT_OUT.unlink()
        with zipfile.ZipFile(CLIENT_OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as out:
            for name in selected:
                data = src.read(name)
                zi = zipfile.ZipInfo(name, FIXED_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                out.writestr(zi, data)

            readme = (
                "KafePin Client v3.1.62\r\n"
                "======================\r\n"
                "Runtime dosyalari kilitli v3.1.60 FINAL yeni-kafe paketinden byte-for-byte alinmistir.\r\n"
                "Client ping/cark/EveryCafe/session davranisi degistirilmemistir.\r\n"
                "Sunucu v3.1.60 kurulumdan sonra en guncel kumulatif STABLE surume yukseltilir.\r\n"
            ).encode("utf-8-sig")
            zi = zipfile.ZipInfo("CLIENT-OKU-BENI.txt", FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, readme)

    # Runtime bytes in the client ZIP must equal the v3.1.60 FINAL source exactly.
    with zipfile.ZipFile(NEW_CAFE_BASE, "r") as src, zipfile.ZipFile(CLIENT_OUT, "r") as out:
        for name in selected:
            if hashlib.sha256(src.read(name)).digest() != hashlib.sha256(out.read(name)).digest():
                raise SystemExit("client runtime changed from v3.1.60 FINAL: " + name)
    return selected


def build() -> None:
    if not BASE.exists():
        raise SystemExit("v3.1.60 FINAL update base missing")

    with tempfile.TemporaryDirectory(prefix="kp3162-v3160-") as td:
        work = Path(td) / "work"
        work.mkdir()
        with zipfile.ZipFile(BASE, "r") as z:
            z.extractall(work)

        required = [
            work / "KafePin_Manager_Ensure.ps1",
            work / "KafePin_Desktop_App_Setup.ps1",
            work / "server.js",
        ]
        for p in required:
            if not p.is_file():
                raise SystemExit("required v3.1.60 file missing: " + str(p.relative_to(work)))

        validate_v3160_identity_markers(work)
        before = file_sha_map(work)
        patch_manager(work / "KafePin_Manager_Ensure.ps1")
        write_metadata(work)
        after = file_sha_map(work)
        verify_only_allowed_changes(before, after)
        validate_v3160_identity_markers(work)
        pack_tree(work, OUT)

    digest = sha256(OUT)
    SHA_FILE.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    client_files = build_client_from_v3160()
    client_digest = sha256(CLIENT_OUT)

    REPORT.write_text(
        "# KafePin Pro v3.1.62 — v3.1.60 FINAL Koruma Sürümü\n\n"
        "- Kaynak doğrudan **KafePin Pro v3.1.60 FINAL / STABLE** paketidir.\n"
        "- v3.1.60'taki arayüz, kartlar ve tüm PRO menüleri byte-for-byte korunur.\n"
        "- `PRO Servisleri Yenile` v3.1.60'taki haliyle korunur; yeni bir UI davranışı yazılmaz.\n"
        "- Yalnız Server Manager içindeki eski `v3.1.57 Yazici payload` zorunluluğu kaldırılır.\n"
        "- Desktop setup dosyası değiştirilmez; v3.1.60 FINAL'daki kendi varsayılan sürümü kullanılır.\n"
        "- `server.js`, finans, spin, session, EveryCafe read-only, Telegram ve 20:00 işletme günü dosyaları değiştirilmez.\n"
        "- Client runtime dosyaları v3.1.60 FINAL yeni-kafe paketinden byte-for-byte alınır.\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n"
        f"- Client runtime dosya sayısı: **{len(client_files)}**\n",
        encoding="utf-8",
    )
    print("V3162_V3160_EXACT_OK", digest, OUT.stat().st_size, "CLIENT", client_digest, len(client_files))


if __name__ == "__main__":
    build()
