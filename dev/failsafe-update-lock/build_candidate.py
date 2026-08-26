from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

from patch_server import patch_server

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v4.0.2.zip"
OUT = ROOT / "KafePin-Pro-Update-v4.0.3-FAILSAFE-CANDIDATE.zip"
SHA = ROOT / "KafePin-Pro-Update-v4.0.3-FAILSAFE-CANDIDATE.sha256.txt"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    base_bytes = BASE.read_bytes()
    with zipfile.ZipFile(io.BytesIO(base_bytes), "r") as src:
        update = json.loads(src.read("update.json").decode("utf-8-sig"))
        patched_server = patch_server(src.read("server.js").decode("utf-8-sig")).encode("utf-8")
        update.update({
            "version": "4.0.3",
            "channel": "candidate",
            "finalStable": False,
            "sourceVersion": "4.0.2",
            "sourceSha256": digest(base_bytes),
            "buildRevision": "v403-failsafe-update-lock-r1",
            "files": ["server.js"],
            "notes": [
                "TEST only: fail-safe update lock recovery.",
                "Startup validates lock age, state, owner/supervisor PID and server/DB health.",
                "No database.db, WAL/SHM, finance, EveryCafe, session or spin payload is changed.",
            ],
        })
        update_bytes = (json.dumps(update, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w") as dst:
            for info in src.infolist():
                data = src.read(info.filename)
                if info.filename == "update.json":
                    data = update_bytes
                elif info.filename == "server.js":
                    data = patched_server
                dst.writestr(info, data)
        OUT.write_bytes(out.getvalue())

    value = digest(OUT.read_bytes())
    SHA.write_text(f"{value}  {OUT.name}\n", encoding="ascii")
    print(f"FAILSAFE_CANDIDATE_OK {value} {OUT.stat().st_size}")


if __name__ == "__main__":
    main()
