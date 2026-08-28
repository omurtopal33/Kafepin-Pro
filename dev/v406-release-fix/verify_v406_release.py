from __future__ import annotations

import ast
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_NAME = "KafePin-Pro-Update-v4.0.6-CLIENT-PERFORMANS-UNIFIED-TEST-R2.zip"
STABLE_NAME = "KafePin-Pro-Update-v4.0.6-STABLE.zip"
SOURCE = ROOT / SOURCE_NAME
STABLE = ROOT / STABLE_NAME
SOURCE_SIZE = 835801
SOURCE_SHA = "bceae3b96db509121b7232439848dd0dc9860b177ac45e6a49ea20fa039d395c"
METADATA_FILES = {"update.json", "kafepin-pro-version.json"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive_entries(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise AssertionError(f"Corrupt ZIP member: {corrupt}")
        return {name: archive.read(name) for name in archive.namelist()}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    require(SOURCE.is_file(), "Field TEST source artifact missing")
    require(SOURCE.stat().st_size == SOURCE_SIZE, "Field TEST source size mismatch")
    require(file_sha(SOURCE) == SOURCE_SHA, "Field TEST source SHA mismatch")
    require(STABLE.is_file(), "STABLE artifact missing")

    source = archive_entries(SOURCE)
    stable = archive_entries(STABLE)
    require(set(source) == set(stable), "Archive member list changed")
    changed = {name for name in source if sha(source[name]) != sha(stable[name])}
    require(changed == METADATA_FILES, f"Unexpected changed archive members: {sorted(changed)}")

    for name in stable:
        lowered = name.lower().replace("\\", "/")
        require(not lowered.endswith(("database.db", "database.db-wal", "database.db-shm")), f"Database payload forbidden: {name}")

    for name in METADATA_FILES:
        test_meta = json.loads(source[name].decode("utf-8-sig"))
        stable_meta = json.loads(stable[name].decode("utf-8-sig"))
        require(test_meta.get("channel") == "test" and test_meta.get("finalStable") is False, f"Source TEST metadata changed: {name}")
        require(stable_meta.get("version") == "4.0.6", f"STABLE version mismatch: {name}")
        require(stable_meta.get("channel") == "stable" and stable_meta.get("finalStable") is True, f"STABLE flags mismatch: {name}")
        require(stable_meta.get("stableBase") == stable_meta.get("baseVersion") == stable_meta.get("futureUpdateBase") == "3.1.64", f"Base policy mismatch: {name}")
        require(stable_meta.get("files") == test_meta.get("files"), f"Update file list changed: {name}")
        require(stable_meta.get("promotedFromSha256") == SOURCE_SHA, f"Promotion source missing: {name}")
        require(stable_meta.get("payloadChanged") is False, f"Payload promotion flag mismatch: {name}")
        require(not any("STABLE/FINAL değildir" in str(note) for note in stable_meta.get("notes") or []), f"TEST disclaimer remains: {name}")

    latest = json.loads((ROOT / "latest.json").read_text(encoding="utf-8-sig"))
    latest_test = json.loads((ROOT / "latest-test.json").read_text(encoding="utf-8-sig"))
    stable_sha = file_sha(STABLE)
    require(latest.get("version") == "4.0.6" and latest.get("channel") == "stable" and latest.get("finalStable") is True, "latest.json STABLE flags mismatch")
    require(latest.get("sha256") == stable_sha, "latest.json SHA mismatch")
    require(str(latest.get("downloadUrl") or "").endswith("/" + STABLE_NAME), "latest.json URL mismatch")
    require(latest_test.get("stableVersion") == "4.0.6" and latest_test.get("available") is False, "latest-test.json mismatch")

    checksum = (ROOT / "KafePin-Pro-Update-v4.0.6-STABLE.sha256.txt").read_text(encoding="ascii").strip()
    require(checksum == f"{stable_sha}  {STABLE_NAME}", "STABLE checksum file mismatch")
    source_checksum = (ROOT / f"{SOURCE_NAME}.sha256.txt").read_text(encoding="ascii").strip()
    require(source_checksum == f"{SOURCE_SHA}  {SOURCE_NAME}", "Source checksum file mismatch")

    subprocess.run(["node", "--check", "-"], input=stable["server.js"], check=True)
    subprocess.run(["node", "--check", "-"], input=stable["KafePin_Update_Supervisor.js"], check=True)
    nested = archive_entries_from_bytes(stable["pro-components/client-performans-pro.zip"])
    ast.parse(nested["web_service.py"].decode("utf-8-sig"))
    subprocess.run(["node", "--check", "-"], input=nested["web/app.js"], check=True)

    print("V406_RELEASE_VERIFY_OK")
    print(f"SOURCE_SIZE={SOURCE.stat().st_size}")
    print(f"SOURCE_SHA256={SOURCE_SHA}")
    print(f"STABLE_SIZE={STABLE.stat().st_size}")
    print(f"STABLE_SHA256={stable_sha}")
    print("CHANGED_ARCHIVE_MEMBERS=" + ",".join(sorted(changed)))
    print("PAYLOAD_UNCHANGED=true")
    print("DATABASE_PAYLOAD=false")


def archive_entries_from_bytes(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise AssertionError(f"Corrupt nested ZIP member: {corrupt}")
        return {name: archive.read(name) for name in archive.namelist()}


if __name__ == "__main__":
    main()
