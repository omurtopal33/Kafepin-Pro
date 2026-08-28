from __future__ import annotations

import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE_NAME = "KafePin-Pro-Update-v4.0.6-STABLE.zip"
CANDIDATE_NAME = "KafePin-Pro-Update-v4.0.7-TEST-EDEVLET-PRINT-TOTAL-R1.zip"
BASE = ROOT / BASE_NAME
CANDIDATE = ROOT / CANDIDATE_NAME
BASE_SIZE = 835933
BASE_SHA = "f6446ef5538eec9cd2cb4df2c6d72efc702b02df329e293333506e41ec74a6a4"
YAZICI_ZIP_SHA = "280d28f909604a4647c1d3b64a208505aea34ff18893f26ca7f31b01f4c63df7"
METADATA_FILES = {"update.json", "kafepin-pro-version.json"}
TARGET_FILES = ["KafePin_Update_Supervisor.js", "pro-components/yazici-pro.zip"]
YAZICI_CHANGED_FILES = {"KafePin_YaziciGelir_Service.js", "yazici-pro-version.json"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def entries_from_bytes(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        corrupt = archive.testzip()
        require(corrupt is None, f"Corrupt nested ZIP member: {corrupt}")
        return {name: archive.read(name) for name in archive.namelist()}


def entries(path: Path) -> dict[str, bytes]:
    return entries_from_bytes(path.read_bytes())


def main() -> None:
    require(BASE.is_file() and BASE.stat().st_size == BASE_SIZE, "Locked v4.0.6 STABLE base size mismatch")
    require(file_sha(BASE) == BASE_SHA, "Locked v4.0.6 STABLE base SHA mismatch")
    require(CANDIDATE.is_file(), "v4.0.7 TEST candidate missing")

    base = entries(BASE)
    candidate = entries(CANDIDATE)
    require(set(base) == set(candidate), "Cumulative archive member list changed")
    changed = {name for name in base if sha(base[name]) != sha(candidate[name])}
    require(changed == METADATA_FILES | {"pro-components/yazici-pro.zip"}, f"Unexpected changed archive members: {sorted(changed)}")

    for name in candidate:
        lowered = name.lower().replace("\\", "/")
        require(not lowered.endswith(("database.db", "database.db-wal", "database.db-shm")), f"Database payload forbidden: {name}")

    for name in METADATA_FILES:
        meta = json.loads(candidate[name].decode("utf-8-sig"))
        require(meta.get("version") == "4.0.7", f"TEST version mismatch: {name}")
        require(meta.get("channel") == "test" and meta.get("finalStable") is False, f"TEST flags mismatch: {name}")
        require(meta.get("files") == TARGET_FILES, f"Targeted update files mismatch: {name}")
        require(meta.get("sourceVersion") == "4.0.6" and meta.get("sourceSha256") == BASE_SHA, f"STABLE base provenance mismatch: {name}")
        require(meta.get("stableBase") == meta.get("baseVersion") == meta.get("futureUpdateBase") == "3.1.64", f"Base policy mismatch: {name}")
        require(meta.get("payloadSourceUnchanged") is False, f"Targeted payload provenance flag mismatch: {name}")

    require(sha(base["pro-components/yazici-pro.zip"]) == YAZICI_ZIP_SHA, "Locked v4.0.6 Yazici PRO payload mismatch")
    base_nested = entries_from_bytes(base["pro-components/yazici-pro.zip"])
    nested = entries_from_bytes(candidate["pro-components/yazici-pro.zip"])
    require(set(base_nested) == set(nested), "Yazici PRO member list changed")
    nested_changed = {name for name in base_nested if sha(base_nested[name]) != sha(nested[name])}
    require(nested_changed == YAZICI_CHANGED_FILES, f"Unexpected Yazici PRO changes: {sorted(nested_changed)}")
    revenue = nested["KafePin_YaziciGelir_Service.js"].decode("utf-8-sig")
    for marker in ("appendPrintJobsToTransaction", "/edevlet/session/active", "/edevlet/session/remove-print", "active_session===true", "recoverable=Object.values", "e-Devlet canlı/bekleyen çıktı eklendi"):
        require(marker in revenue, f"e-Devlet live total marker missing: {marker}")
    yazici_meta = json.loads(nested["yazici-pro-version.json"].decode("utf-8-sig"))
    require(yazici_meta.get("version") == "3.1.62", "Yazici PRO component version mismatch")
    require(yazici_meta.get("build") == "v407-edevlet-print-recovery-r1", "Yazici PRO build marker mismatch")

    supervisor = candidate["KafePin_Update_Supervisor.js"].decode("utf-8-sig")
    for marker in ("const yaziciOnly=updateFiles.length===2", "updateFiles.includes('pro-components/yazici-pro.zip')", "'-Action','repair','-Component','yazici-pro'", "desktop shell and other PRO refresh skipped"):
        require(marker in supervisor, f"Targeted Yazici repair marker missing: {marker}")

    manager = candidate["KafePin_Pro_Component_Manager.ps1"].decode("utf-8-sig")
    require("Copy-ComponentFiles $temp $info.target ([bool]$info.installed)" in manager, "Component repair overlay marker missing")

    subprocess.run(["node", "--check", "-"], input=candidate["KafePin_Update_Supervisor.js"], check=True)
    subprocess.run(["node", "--check", "-"], input=nested["KafePin_YaziciGelir_Service.js"], check=True)
    test_script = ROOT / "dev" / "v407-edevlet-print" / "test_edevlet_session_total.js"
    subprocess.run(["node", str(test_script), "-"], input=nested["KafePin_YaziciGelir_Service.js"], check=True)

    print("V407_EDEVLET_PRINT_VERIFY_OK")
    print(f"BASE_SIZE={BASE.stat().st_size}")
    print(f"BASE_SHA256={BASE_SHA}")
    print(f"CANDIDATE_SIZE={CANDIDATE.stat().st_size}")
    print(f"CANDIDATE_SHA256={file_sha(CANDIDATE)}")
    print("CHANGED_ARCHIVE_MEMBERS=" + ",".join(sorted(changed)))
    print("TARGETED_INSTALL_FILES=" + ",".join(TARGET_FILES))
    print("YAZICI_CHANGED_FILES=" + ",".join(sorted(nested_changed)))
    print("OTHER_PAYLOAD_UNCHANGED=true")
    print("DATABASE_PAYLOAD=false")


if __name__ == "__main__":
    main()
