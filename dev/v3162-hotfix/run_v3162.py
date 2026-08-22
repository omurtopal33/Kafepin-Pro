from __future__ import annotations

import importlib.util
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD_PATH = HERE / "build_v3162.py"

spec = importlib.util.spec_from_file_location("kafepin_v3162_builder", BUILD_PATH)
if spec is None or spec.loader is None:
    raise SystemExit("v3.1.62 builder could not be loaded")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def robust_patch_manager(path: Path) -> None:
    text = path.read_text(encoding="utf-8-sig")

    # Some v3.1.60 package variants contain the old Yazici payload fatal throw,
    # while the dedicated release/v3.1.60-stable pair does not. Neutralize it
    # only when it actually exists; do not depend on an old candidate comment.
    fatal_re = re.compile(
        r"(?m)^(?P<indent>\s*)throw\s+['\"]v3\.1\.57 Yazici payload klasoru bulunamadi\.?['\"]\s*;?\s*$"
    )
    text, fatal_count = fatal_re.subn(
        lambda m: m.group("indent") + "Write-Host 'v3.1.62: eski Yazici payload eksik; Manager/Desktop kurulumu devam ediyor.'",
        text,
    )

    desktop_marker = f"-AppVersion '{mod.DESKTOP_VERSION}'"
    if desktop_marker not in text:
        block = f'''  # v3.1.62 - v3.1.60 FINAL cekirdegi korunur; yalnız Desktop v{mod.DESKTOP_VERSION} uygulanır.\n  $kpDesktopSetup = Join-Path $InstallRoot 'KafePin_Desktop_App_Setup.ps1'\n  if (-not (Test-Path -LiteralPath $kpDesktopSetup -PathType Leaf)) {{ throw 'KafePin_Desktop_App_Setup.ps1 bulunamadi.' }}\n  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $kpDesktopSetup -InstallRoot $InstallRoot -AppVersion '{mod.DESKTOP_VERSION}'\n  if ($LASTEXITCODE -ne 0) {{ throw ('KafePin ana masaustu uygulamasi guncellenemedi. Cikis=' + $LASTEXITCODE) }}\n'''

        anchors = [
            "  if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf))",
            "if (-not (Test-Path -LiteralPath $ManagerSource -PathType Leaf))",
            "$ManagerSource =",
        ]
        pos = -1
        for anchor in anchors:
            pos = text.find(anchor)
            if pos >= 0:
                break
        if pos < 0:
            raise SystemExit("stable v3.1.60 Manager insertion anchor not found")
        line_start = text.rfind("\n", 0, pos) + 1
        text = text[:line_start] + block + text[line_start:]

    if "v3.1.57 Yazici payload klasoru bulunamadi" in text:
        raise SystemExit("legacy fatal Yazici payload text survived Manager adapter")
    if desktop_marker not in text:
        raise SystemExit("desktop v1.1.8 force-rebuild marker missing after Manager adapter")

    path.write_text(text, encoding="utf-8-sig")
    print("MANAGER_ADAPTER_OK", "fatal_neutralized=" + str(fatal_count), desktop_marker)


mod.patch_manager = robust_patch_manager
mod.build()
