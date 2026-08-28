from __future__ import annotations

import argparse
import hashlib
import io
import json
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE_NAME = "KafePin-Pro-Update-v4.0.6-CLIENT-PERFORMANS-UNIFIED-TEST-R2.zip"
STABLE_NAME = "KafePin-Pro-Update-v4.0.6-STABLE.zip"
SOURCE = ROOT / SOURCE_NAME
EXPECTED_SOURCE_SIZE = 835801
EXPECTED_SOURCE_SHA256 = "bceae3b96db509121b7232439848dd0dc9860b177ac45e6a49ea20fa039d395c"
FIXED_TIME = (2026, 8, 28, 6, 0, 0)
METADATA_FILES = {"update.json", "kafepin-pro-version.json"}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def zip_bytes(entries: dict[str, bytes]) -> bytes:
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entries[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return target.getvalue()


def promote_metadata(source: dict) -> dict:
    result = dict(source)
    replacements = {
        "v4.0.6 TEST R2:": "v4.0.6 STABLE:",
        "v4.0.6 TEST:": "v4.0.6 STABLE:",
        "Bu paket TEST candidate’dır; saha doğrulaması yapılmadan STABLE/FINAL değildir.":
            "v4.0.6 saha doğrulaması tamamlandı; çalışan payload değiştirilmeden STABLE/FINAL metadata ile yayımlandı.",
    }
    notes = []
    for note in source.get("notes") or []:
        value = str(note)
        if value == "Masa ping verdiginde degil, EveryCafe ClientStatus Beklemede oldugunda secilir; pencere/proses odagi dogrulanir.":
            continue
        for old, new in replacements.items():
            if value.startswith(old):
                value = new + value[len(old):]
            elif value == old:
                value = new
        notes.append(value)
    result.update(
        {
            "version": "4.0.6",
            "channel": "stable",
            "finalStable": True,
            "stableBase": "3.1.64",
            "baseVersion": "3.1.64",
            "futureUpdateBase": "3.1.64",
            "cumulative": True,
            "publishedAt": "2026-08-28T06:00:00+03:00",
            "notes": notes,
            "buildRevision": "v406-stable-clientperformans-unified-r2-metadata-r1",
            "mode": "stable",
            "installedAt": "",
            "promotedFromArtifact": SOURCE_NAME,
            "promotedFromSha256": EXPECTED_SOURCE_SHA256,
            "payloadChanged": False,
        }
    )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not SOURCE.is_file() or SOURCE.stat().st_size != EXPECTED_SOURCE_SIZE:
        raise SystemExit("Locked field TEST artifact size mismatch")
    if sha256_file(SOURCE) != EXPECTED_SOURCE_SHA256:
        raise SystemExit("Locked field TEST artifact SHA-256 mismatch")

    with zipfile.ZipFile(SOURCE) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Locked field TEST artifact is corrupt")
        entries = {name: archive.read(name) for name in archive.namelist()}
    for name in METADATA_FILES:
        source_metadata = json.loads(entries[name].decode("utf-8-sig"))
        entries[name] = (json.dumps(promote_metadata(source_metadata), ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    stable = output_dir / STABLE_NAME
    stable.write_bytes(zip_bytes(entries))
    stable_sha = sha256_file(stable)
    manifest = {
        "schema": 1,
        "version": "4.0.6",
        "sourceArtifact": SOURCE_NAME,
        "sourceArtifactSize": EXPECTED_SOURCE_SIZE,
        "sourceArtifactSha256": EXPECTED_SOURCE_SHA256,
        "stableArtifact": STABLE_NAME,
        "stableArtifactSize": stable.stat().st_size,
        "stableArtifactSha256": stable_sha,
        "changedArchiveMembers": sorted(METADATA_FILES),
        "payloadMembersUnchanged": True,
        "databasePayloadPresent": False,
        "build": "Windows Python 3.13.15 stdlib zipfile, DEFLATE level 9, fixed timestamp 2026-08-28T06:00:00",
    }
    (output_dir / "V4.0.6-STABLE-SHA256SUMS.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output_dir / f"{STABLE_NAME}.sha256.txt").write_text(f"{stable_sha}  {STABLE_NAME}\n", encoding="ascii")
    print(f"SOURCE_SHA256={EXPECTED_SOURCE_SHA256}")
    print(f"STABLE={stable}")
    print(f"STABLE_SIZE={stable.stat().st_size}")
    print(f"STABLE_SHA256={stable_sha}")


if __name__ == "__main__":
    main()
