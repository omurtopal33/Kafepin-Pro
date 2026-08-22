from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
UPDATE_BASE = ROOT / "KafePin-Pro-Update-v3.1.60.zip"
NEW_CAFE_BASE = ROOT / "KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.62.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.62.sha256.txt"
CLIENT_OUT = ROOT / "KafePin-Client-v3.1.62.zip"
REPORT = ROOT / "RELEASE_NOTES-v3.1.62.md"
FIXED_DT = (2026, 8, 22, 16, 30, 0)
VERSION = "3.1.62"

# v3.1.60 FINAL consists of the locked UPDATE + NEW-CAFE pair. The new-cafe
# package is authoritative for runtime files that exist in both packages,
# because finalize_v3160 copied the final live installer/runtime material into
# it. v3.1.62 may then change only Manager + version metadata.
ALLOWED_CHANGED_FILES = {
    "KafePin_Manager_Ensure.ps1",
    "update.json",
    "kafepin-pro-version.json",
}

NOTES = (
    "v3.1.62 STABLE kümülatif onarım: kilitli v3.1.60 FINAL UPDATE + YENİ KAFE paket çifti "
    "kaynak alınır. İki pakette ortak olan runtime dosyalarında YENİ KAFE FINAL kopyası otoritedir; "
    "böylece sahada son haline getirilen kartlar, masaüstü arayüzü ve PRO kontrolleri korunur. Yalnız "
    "eski v3.1.57 Yazıcı payload zorunluluğunun Server Manager hazırlığını durdurması kaldırılır ve sürüm "
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


def marker_paths(root: Path, marker: str) -> list[str]:
    needle = marker.casefold()
    found: list[str] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".cs", ".html", ".js", ".ps1", ".cmd", ".txt", ".json", ".css"}:
            continue
        try:
            text = p.read_text(encoding="utf-8-sig", errors="ignore")
        except Exception:
            continue
        if needle in text.casefold():
            found.append(p.relative_to(root).as_posix())
    return found


def build_v3160_canonical(update_root: Path, new_cafe_root: Path, canonical: Path) -> list[str]:
    shutil.copytree(update_root, canonical)
    overlaid: list[str] = []
    for dst in sorted(p for p in canonical.rglob("*") if p.is_file()):
        rel = dst.relative_to(canonical)
        src = new_cafe_root / rel
        if src.is_file():
            dst.write_bytes(src.read_bytes())
            overlaid.append(rel.as_posix())
    return overlaid


def validate_v3160_identity(canonical: Path, new_cafe_root: Path) -> dict[str, list[str]]:
    required = [
        "PRO Servisleri Yenile",
        "MP3 Bot PRO",
        "Yazıcı PRO",
        "Teknik Servis PRO",
    ]
    locations: dict[str, list[str]] = {}
    missing: list[str] = []
    for marker in required:
        paths = marker_paths(canonical, marker)
        if not paths:
            # Diagnostic: the marker may live only in a new-cafe-only installer file.
            nc_paths = marker_paths(new_cafe_root, marker)
            if nc_paths:
                raise SystemExit(
                    "v3.1.60 FINAL marker exists only in new-cafe-only path and is not update-applicable: "
                    + marker + " => " + ", ".join(nc_paths)
                )
            missing.append(marker)
        else:
            locations[marker] = paths
    if missing:
        raise SystemExit("v3.1.60 FINAL identity marker missing from locked FINAL pair: " + ", ".join(missing))

    server = canonical / "server.js"
    if not server.is_file():
        raise SystemExit("server.js missing from v3.1.60 FINAL canonical set")
    server_text = server.read_text(encoding="utf-8-sig", errors="ignore")
    if "available: compareProVersions(remote.version, current) > 0" not in server_text:
        raise SystemExit("v3.1.60 safe update equality guard missing")
    return locations


def patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")
    start_marker = "  # v3.1.57 CANDIDATE1 - hizli/kumulatif Yazici PRO uygulamasi."
    end_marker = "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf)) { throw 'Manager kaynak dosyasi yok.' }"
    start = text.find(start_marker)
    end = text.find(end_marker)
    if start < 0 or end < 0 or end <= start:
        raise SystemExit("legacy Manager Yazici block markers not found in v3.1.60 FINAL canonical Manager")

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
        "v3160FinalPairPreserved": True,
        "publishedAt": "2026-08-22T16:30:00+03:00",
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
        raise SystemExit(f"v3.1.60 canonical file set changed; added={added}, removed={removed}")

    changed = {name for name in before_files if before[name] != after[name]}
    unexpected = sorted(changed - ALLOWED_CHANGED_FILES)
    required_changed = sorted(ALLOWED_CHANGED_FILES - changed)
    if unexpected:
        raise SystemExit("unexpected v3.1.60 FINAL file changes: " + ", ".join(unexpected))
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
                "Runtime dosyalari kilitli v3.1.60 FINAL YENI KAFE paketinden byte-for-byte alinmistir.\r\n"
                "Client ping/cark/EveryCafe/session davranisi degistirilmemistir.\r\n"
                "Yeni kafede once v3.1.60 FINAL kurulur; sunucu sonra en guncel kumulatif STABLE surume yukselir.\r\n"
            ).encode("utf-8-sig")
            zi = zipfile.ZipInfo("CLIENT-OKU-BENI.txt", FIXED_DT)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            out.writestr(zi, readme)

    with zipfile.ZipFile(NEW_CAFE_BASE, "r") as src, zipfile.ZipFile(CLIENT_OUT, "r") as out:
        for name in selected:
            if hashlib.sha256(src.read(name)).digest() != hashlib.sha256(out.read(name)).digest():
                raise SystemExit("client runtime changed from v3.1.60 FINAL: " + name)
    return selected


def build() -> None:
    for required in (UPDATE_BASE, NEW_CAFE_BASE):
        if not required.exists():
            raise SystemExit("missing locked v3.1.60 FINAL package: " + required.name)

    with tempfile.TemporaryDirectory(prefix="kp3162-v3160-final-") as td:
        tmp = Path(td)
        update_root = tmp / "update-base"
        new_cafe_root = tmp / "new-cafe-base"
        canonical = tmp / "canonical"
        update_root.mkdir()
        new_cafe_root.mkdir()
        with zipfile.ZipFile(UPDATE_BASE, "r") as z:
            z.extractall(update_root)
        with zipfile.ZipFile(NEW_CAFE_BASE, "r") as z:
            z.extractall(new_cafe_root)

        overlaid = build_v3160_canonical(update_root, new_cafe_root, canonical)
        required = [
            canonical / "KafePin_Manager_Ensure.ps1",
            canonical / "KafePin_Desktop_App_Setup.ps1",
            canonical / "server.js",
        ]
        for p in required:
            if not p.is_file():
                raise SystemExit("required v3.1.60 FINAL file missing: " + str(p.relative_to(canonical)))

        marker_locations = validate_v3160_identity(canonical, new_cafe_root)
        before = file_sha_map(canonical)
        patch_manager(canonical / "KafePin_Manager_Ensure.ps1")
        write_metadata(canonical)
        after = file_sha_map(canonical)
        verify_only_allowed_changes(before, after)
        validate_v3160_identity(canonical, new_cafe_root)
        pack_tree(canonical, OUT)

    digest = sha256(OUT)
    SHA_FILE.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    client_files = build_client_from_v3160()
    client_digest = sha256(CLIENT_OUT)

    marker_text = "\n".join(
        f"- `{marker}`: {', '.join(paths)}" for marker, paths in sorted(marker_locations.items())
    )
    REPORT.write_text(
        "# KafePin Pro v3.1.62 — v3.1.60 FINAL Tam Koruma\n\n"
        "- Kaynak **kilitli v3.1.60 FINAL UPDATE + YENİ KAFE paket çiftidir**.\n"
        "- Ortak runtime dosyalarında YENİ KAFE FINAL kopyası otorite kabul edilir; bu, sahada son hale getirilen UI/kartları güncellemeye taşır.\n"
        "- `PRO Servisleri Yenile` ve tüm PRO menüleri v3.1.60 FINAL'daki haliyle korunur; yeni bir UI davranışı yazılmaz.\n"
        "- Yalnız Server Manager içindeki eski `v3.1.57 Yazici payload` zorunluluğu kaldırılır.\n"
        "- `server.js`, finans, spin, session, EveryCafe read-only, Telegram ve 20:00 işletme günü davranışları değiştirilmez.\n"
        "- Client runtime dosyaları v3.1.60 FINAL YENİ KAFE paketinden byte-for-byte alınır.\n"
        f"- Final ortak dosya overlay sayısı: **{len(overlaid)}**\n"
        f"- Update SHA256: `{digest}`\n"
        f"- Client SHA256: `{client_digest}`\n"
        f"- Client runtime dosya sayısı: **{len(client_files)}**\n\n"
        "## v3.1.60 FINAL kimlik markerları\n"
        + marker_text + "\n",
        encoding="utf-8",
    )
    print("V3162_V3160_FINAL_PAIR_OK", digest, OUT.stat().st_size, "CLIENT", client_digest, len(client_files))
    print("V3160_OVERLAY_COUNT", len(overlaid))
    for marker, paths in sorted(marker_locations.items()):
        print("MARKER", marker, "=>", ";".join(paths))


if __name__ == "__main__":
    build()
