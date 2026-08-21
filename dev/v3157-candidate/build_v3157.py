from __future__ import annotations
import hashlib, json, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.56.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.57.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.57.sha256.txt"
LATEST = ROOT / "latest.json"
REPORT = ROOT / "V3.1.57-CANDIDATE-TEST-REPORT.md"
FIXED_DT = (2026, 8, 21, 11, 58, 0)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"patch marker missing: {label}")
    return text.replace(old, new, 1)


def build() -> None:
    if not BASE.exists():
        raise SystemExit("v3.1.56 base package missing")
    with tempfile.TemporaryDirectory(prefix="kp3157-") as td:
        work = Path(td) / "work"
        work.mkdir()
        with zipfile.ZipFile(BASE, "r") as z:
            z.extractall(work)

        old_payload = work / "v3156-yazici-payload"
        payload = work / "v3157-yazici-payload"
        if not old_payload.exists():
            raise SystemExit("v3156 payload missing")
        old_payload.rename(payload)

        # Only the component metadata changes. Runtime services remain the exact
        # field-tested v3.1.56 binaries/scripts.
        ver_path = payload / "yazici-pro-version.json"
        ver = json.loads(ver_path.read_text(encoding="utf-8-sig"))
        ver["version"] = "3.1.57"
        ver["build"] = "candidate1"
        ver["updaterHashVerification"] = "verified-package-source-to-destination-sha256"
        fixes = list(ver.get("fixes") or [])
        for item in ["stale-embedded-sha-eliminated", "source-destination-sha256-copy-check", "v3156-final-pair-regex-bug-fixed-by-design"]:
            if item not in fixes:
                fixes.append(item)
        ver["fixes"] = fixes
        ver_path.write_text(json.dumps(ver, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        mgr_path = work / "KafePin_Manager_Ensure.ps1"
        mgr = mgr_path.read_text(encoding="utf-8-sig")
        mgr = replace_once(mgr, "  [string]$NodePath = ''\n)", "  [string]$NodePath = '',\n  [switch]$VerifyYaziciPayloadOnly\n)", "manager verify-only param")
        for a, b in [
            ("v3156-yazici-payload", "v3157-yazici-payload"),
            ("v3156-yazici-apply.log", "v3157-yazici-apply.log"),
            ("v3156-yazici-applied.json", "v3157-yazici-applied.json"),
            ("v3.1.56 CANDIDATE1", "v3.1.57 CANDIDATE1"),
            ("v3.1.56 Yazici payload", "v3.1.57 Yazici payload"),
            ("[v3.1.56-candidate1]", "[v3.1.57-candidate1]"),
            ("version='3.1.56'; build='candidate1'", "version='3.1.57'; build='candidate1'"),
        ]:
            mgr = mgr.replace(a, b)

        old_loop = """    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null\n    Copy-Item -LiteralPath $src -Destination $dst -Force\n    if ((YaziciFileSha $dst) -ne [string]$pair.Sha) { throw ('Yazici PRO SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }\n  }\n"""
        new_loop = """    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null\n    # Tum ZIP, indirme asamasinda latest.json SHA256 ile dogrulanir. Burada\n    # build zamaninda gomulmus ve bayatlayabilen pair.Sha yerine, dogrulanmis\n    # paketteki GERCEK kaynak dosyanin SHA256'si kopyalanan hedefle karsilastirilir.\n    $sourceSha = YaziciFileSha $src\n    Copy-Item -LiteralPath $src -Destination $dst -Force\n    $destSha = YaziciFileSha $dst\n    if ($destSha -ne $sourceSha) { throw ('Yazici PRO kaynak-hedef SHA256 dogrulamasi basarisiz: ' + [string]$pair.Dst) }\n  }\n  if ($VerifyYaziciPayloadOnly) {\n    YaziciLog 'BASARILI: tum Yazici PRO payload dosyalari kaynak-hedef SHA256 ile dogrulandi.'\n    Write-Output 'KAFEPIN_YAZICI_RUNTIME_SHA_VERIFY_OK'\n    exit 0\n  }\n"""
        mgr = replace_once(mgr, old_loop, new_loop, "runtime source-destination SHA loop")
        if "-ne [string]$pair.Sha" in mgr:
            raise SystemExit("stale embedded SHA comparison still active")
        if "$destSha -ne $sourceSha" not in mgr:
            raise SystemExit("runtime source/destination check missing")
        mgr_path.write_text(mgr, encoding="utf-8-sig")

        meta_path = work / "update.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        meta.update({
            "version": "3.1.57",
            "channel": "candidate",
            "stableVersion": "3.1.49",
            "baseVersion": "3.1.49",
            "cumulative": True,
            "notes": "v3.1.57 kesin updater SHA düzeltmesi: Yazıcı PRO dosyalarında build-time gömülü SHA yerine, paket SHA ile doğrulanmış gerçek kaynak dosya ile hedef dosya SHA256 karşılaştırılır. v3.1.56 yazici-pro-version.json son-eleman hash bugı yapısal olarak ortadan kaldırıldı."
        })
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        files = sorted(str(p.relative_to(work)).replace("\\", "/") for p in work.rglob("*") if p.is_file())
        meta["files"] = files
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        files = sorted(str(p.relative_to(work)).replace("\\", "/") for p in work.rglob("*") if p.is_file())

        if OUT.exists():
            OUT.unlink()
        with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for rel in files:
                p = work / rel
                zi = zipfile.ZipInfo(rel, FIXED_DT)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = 0o644 << 16
                z.writestr(zi, p.read_bytes())

    digest = sha256_file(OUT)
    SHA_FILE.write_text(f"{digest}  {OUT.name}\n", encoding="utf-8")
    LATEST.write_text(json.dumps({
        "version": "3.1.57",
        "channel": "candidate",
        "stableVersion": "3.1.49",
        "baseVersion": "3.1.49",
        "cumulative": True,
        "publishedAt": "2026-08-21T11:58:00+03:00",
        "notes": "v3.1.57 ADAY — v3.1.56'daki yazici-pro-version.json bayat SHA kurulum hatasını yapısal olarak kaldırır. Paket bütünlüğü ZIP SHA256 ile, payload kopyası gerçek kaynak→hedef SHA256 ile doğrulanır.",
        "downloadUrl": "https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.57.zip",
        "sha256": digest
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    REPORT.write_text(
        "# KafePin Pro v3.1.57 ADAY — Updater SHA Kesin Düzeltme\n\n"
        "- STABLE: **3.1.49**\n"
        "- Aday: **3.1.57**\n"
        "- Hedef hata: `Yazici PRO SHA256 dogrulamasi basarisiz: yazici-pro-version.json`.\n"
        "- v3.1.56 gerçek payload SHA: `641e2da9159cf7d0ba19ad212e246f2eb186907716a2c4b692a35ead29561b3c`.\n"
        "- v3.1.56 Manager gömülü eski SHA: `8db26084ca7fb091c5be9765d3e28d2a11638447e9abfdcfc73c95319b890ff0`.\n"
        "- Kök neden: build regex'i son `$pairs` elemanında virgül olmadığı için son SHA'yı yenilemiyordu.\n"
        "- v3.1.57: gömülü `$pair.Sha` runtime doğrulama kaynağı değildir; gerçek paket kaynak SHA256 → hedef SHA256 karşılaştırılır.\n"
        "- Windows saha-updater testleri CI tamamlandığında bu rapora geçirilecektir.\n"
        f"- Paket SHA256: `{digest}`\n",
        encoding="utf-8"
    )
    print("V3157_BUILD_OK", digest, OUT.stat().st_size)


if __name__ == "__main__":
    build()
