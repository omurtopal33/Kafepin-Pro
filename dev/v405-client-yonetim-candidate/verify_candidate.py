from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v4.0.4.zip"
ALLOWED_OUTER = {"KafePin_Update_Supervisor.js", "pro-components/client-yonetim-pro.zip", "update.json", "kafepin-pro-version.json"}
ALLOWED_INNER = {"web_service.py"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def entries(path_or_bytes) -> dict[str, bytes]:
    source = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else path_or_bytes
    with zipfile.ZipFile(source) as archive:
        if archive.testzip() is not None:
            raise AssertionError(f"Corrupt ZIP member: {archive.testzip()}")
        return {name: archive.read(name) for name in archive.namelist()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    base = entries(BASE)
    candidate = entries(args.candidate)
    if set(base) != set(candidate):
        raise AssertionError("Outer payload list changed")
    changed_outer = {name for name in base if sha(base[name]) != sha(candidate[name])}
    if changed_outer != ALLOWED_OUTER:
        raise AssertionError(f"Unexpected outer changes: {sorted(changed_outer)}")

    old_component = entries(base["pro-components/client-yonetim-pro.zip"])
    new_component = entries(candidate["pro-components/client-yonetim-pro.zip"])
    if set(old_component) != set(new_component):
        raise AssertionError("Client Yonetim component file list changed")
    changed_inner = {name for name in old_component if sha(old_component[name]) != sha(new_component[name])}
    if changed_inner != ALLOWED_INNER:
        raise AssertionError(f"Unexpected Client Yonetim changes: {sorted(changed_inner)}")

    source = new_component["web_service.py"].decode("utf-8")
    automation = source[source.index("def everycafe_connection"):source.index("PRO_EVENT_URL")]
    if "?mode=ro" not in automation:
        raise AssertionError("EveryCafe connection is not read-only")
    for marker in ("INSERT INTO", "UPDATE Clients", "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE"):
        if marker in automation:
            raise AssertionError(f"Forbidden EveryCafe write marker: {marker}")
    for name in candidate:
        lowered = name.lower()
        if lowered.endswith(("database.db", "database.db-wal", "database.db-shm")):
            raise AssertionError(f"Database payload forbidden: {name}")

    for metadata_name in ("update.json", "kafepin-pro-version.json"):
        metadata = json.loads(candidate[metadata_name].decode("utf-8"))
        expected = {
            "version": "4.0.5",
            "channel": "test",
            "finalStable": False,
            "stableBase": "3.1.64",
            "baseVersion": "3.1.64",
            "futureUpdateBase": "3.1.64",
            "cumulative": True,
            "files": ["KafePin_Update_Supervisor.js", "pro-components/client-yonetim-pro.zip"],
        }
        for key, value in expected.items():
            if metadata.get(key) != value:
                raise AssertionError(f"{metadata_name} {key} mismatch")

    supervisor = candidate["KafePin_Update_Supervisor.js"].decode("utf-8")
    for marker in (
        "const clientYonetimOnly=",
        "'-Component','client-yonetim-pro'",
        "17894,'/api/health?_supervisor=",
        "health.json.everyCafeReadOnly===true",
        "desktop shell and other PRO refresh skipped",
    ):
        if marker not in supervisor:
            raise AssertionError(f"Client Yonetim targeted activation marker missing: {marker}")
    subprocess.run(["node", "--check", "-"], input=supervisor, text=True, check=True)

    print("VERIFY_OK")
    print("OUTER_CHANGED=" + ",".join(sorted(changed_outer)))
    print("INNER_CHANGED=" + ",".join(sorted(changed_inner)))
    print("EVERYCAFE=READ_ONLY")
    print("CORE_AND_OTHER_PRO=BYTE_IDENTICAL")


if __name__ == "__main__":
    main()
