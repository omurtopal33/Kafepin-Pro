from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "KafePin-Pro-Update-v4.0.4.zip"
COMPONENT = Path(__file__).resolve().parent / "component"
SOURCE_SHA256 = "b19eba57237cf3d023740733ed01f166d4e8a881dae3b15ee3d8462a77f0614e"
SOURCE_COMPONENT_SHA256 = "03d1a0b853418165c6b675d084f43273c97e48fe9221d608c523e8b3b479391d"
VERSION = "4.0.5"
REVISION = "v405-test-client-yonetim-everycafe-ui-r1"
OUTPUT_NAME = "KafePin-Pro-Update-v4.0.5-CLIENT-YONETIM-TEST-CANDIDATE.zip"
FIXED_TIME = (2026, 8, 27, 12, 0, 0)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def git_value(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def zip_bytes(entries: dict[str, bytes]) -> bytes:
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entries[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return target.getvalue()


def component_bytes(source_component: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(source_component)) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    expected = {
        "START_CLIENT_YONETIM_PRO.cmd",
        "INSTALL_ELEVATED_SERVICE.ps1",
        "web_service.py",
        "web/index.html",
        "web/app.js",
        "web/style.css",
    }
    if set(entries) != expected:
        raise SystemExit(f"Unexpected locked Client Yonetim payload: {sorted(set(entries) ^ expected)}")
    # Git for Windows may check text files out as CRLF. Canonical LF keeps the
    # exact-SHA build reproducible while all untouched members come directly
    # from the locked v4.0.4 nested ZIP.
    entries["web_service.py"] = (COMPONENT / "web_service.py").read_bytes().replace(b"\r\n", b"\n")
    return zip_bytes(entries)


def supervisor_bytes(source: bytes) -> bytes:
    text = source.decode("utf-8-sig").replace("\r\n", "\n")
    old_detection = """    const componentOnly=unifiedTarget || (updateFiles.length===2 && updateFiles.includes('KafePin_Update_Supervisor.js') && updateFiles.includes('pro-components/yazici-pro.zip'));
"""
    new_detection = """    const yaziciOnly=updateFiles.length===2 && updateFiles.includes('KafePin_Update_Supervisor.js') && updateFiles.includes('pro-components/yazici-pro.zip');
    const clientYonetimOnly=updateFiles.length===2 && updateFiles.includes('KafePin_Update_Supervisor.js') && updateFiles.includes('pro-components/client-yonetim-pro.zip');
    const componentOnly=unifiedTarget || yaziciOnly || clientYonetimOnly;
"""
    if text.count(old_detection) != 1:
        raise SystemExit("Locked supervisor component detection anchor mismatch")
    text = text.replace(old_detection, new_detection)

    manager_anchor = """      const manager=path.join(installRoot,'KafePin_Pro_Component_Manager.ps1');
      if(!fs.existsSync(manager)) throw new Error('Yazici PRO component manager bulunamadi');
"""
    manager_replacement = """      if(unifiedTarget || yaziciOnly){
      const manager=path.join(installRoot,'KafePin_Pro_Component_Manager.ps1');
      if(!fs.existsSync(manager)) throw new Error('Yazici PRO component manager bulunamadi');
"""
    if text.count(manager_anchor) != 1:
        raise SystemExit("Locked supervisor Yazici manager anchor mismatch")
    text = text.replace(manager_anchor, manager_replacement)

    health_anchor = """      log(installRoot,'component-only Yazici PRO health/version verified: '+yazici.details);
    } else {
"""
    health_replacement = """      log(installRoot,'component-only Yazici PRO health/version verified: '+yazici.details);
      } else if(clientYonetimOnly){
        const manager=path.join(installRoot,'KafePin_Pro_Component_Manager.ps1');
        if(!fs.existsSync(manager)) throw new Error('Client Yonetim PRO component manager bulunamadi');
        const r=run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',manager,'-Action','repair','-Component','client-yonetim-pro'],{timeout:120000});
        if(r.code!==0) throw new Error(`Client Yonetim PRO hedefli guncelleme basarisiz: ${(r.stderr||r.stdout).trim().slice(0,1800)}`);
        componentsSynced=true; proServicesRefreshed=true;
        log(installRoot,'component-only activation: Client Yonetim PRO repaired; desktop shell and other PRO refresh skipped');
        const end=Date.now()+20000;
        let clientYonetim={ok:false,details:''};
        while(Date.now()<end){
          const health=await httpJson(17894,'/api/health?_supervisor='+Date.now(),1500);
          const valid=health.ok&&health.json&&health.json.ok===true&&health.json.everyCafeReadOnly===true;
          if(valid){ clientYonetim={ok:true,details:'17894 health/read-only OK'}; break; }
          clientYonetim={ok:false,details:JSON.stringify(health.json||null)};
          await sleep(250);
        }
        if(!clientYonetim.ok) throw new Error(`Client Yonetim PRO 17894 health/read-only dogrulamasi basarisiz: ${clientYonetim.details}`);
        log(installRoot,'component-only Client Yonetim PRO health/read-only verified: '+clientYonetim.details);
      }
    } else {
"""
    if text.count(health_anchor) != 1:
        raise SystemExit("Locked supervisor Yazici health anchor mismatch")
    return text.replace(health_anchor, health_replacement).encode("utf-8")


def candidate_metadata(source: dict, commit: str) -> dict:
    result = dict(source)
    result.update(
        {
            "version": VERSION,
            "channel": "test",
            "finalStable": False,
            "stableBase": "3.1.64",
            "baseVersion": "3.1.64",
            "futureUpdateBase": "3.1.64",
            "cumulative": True,
            "publishedAt": "2026-08-27T12:00:00+03:00",
            "files": ["KafePin_Update_Supervisor.js", "pro-components/client-yonetim-pro.zip"],
            "buildRevision": REVISION,
            "candidateSourceCommit": commit,
        }
    )
    result["notes"] = [
        "v4.0.5 TEST: Client Yonetim PRO EveryCafe UI otomasyonunda hedef masa secimi dogrulanmadan islem tusu gonderilmez.",
        "Sureli Ac, Suresiz Ac ve Ucretsiz Ac mevcut EveryCafe kisayollarini korur; Ucretsiz Ac yildiz islemini kullanir.",
        "Masa ping verdiginde degil, EveryCafe ClientStatus Beklemede oldugunda secilir; pencere/proses odagi dogrulanir.",
        "EveryCafe veritabani salt-okunur kalir; v4.0.4 STABLE cekirdek ve diger PRO payloadlari degistirilmez.",
    ] + list(source.get("notes", []))
    result["mode"] = "test"
    result["installedAt"] = ""
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if file_digest(SOURCE) != SOURCE_SHA256:
        raise SystemExit("Locked v4.0.4 source SHA-256 mismatch")
    commit = git_value("rev-parse", "HEAD")
    if git_value("status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("Build requires no tracked changes beyond the exact source commit")

    with zipfile.ZipFile(SOURCE) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    if digest(entries["pro-components/client-yonetim-pro.zip"]) != SOURCE_COMPONENT_SHA256:
        raise SystemExit("Locked Client Yonetim baseline SHA-256 mismatch")

    component = component_bytes(entries["pro-components/client-yonetim-pro.zip"])
    original_update = json.loads(entries["update.json"].decode("utf-8-sig"))
    original_version = json.loads(entries["kafepin-pro-version.json"].decode("utf-8-sig"))
    entries["pro-components/client-yonetim-pro.zip"] = component
    entries["KafePin_Update_Supervisor.js"] = supervisor_bytes(entries["KafePin_Update_Supervisor.js"])
    entries["update.json"] = (json.dumps(candidate_metadata(original_update, commit), ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    entries["kafepin-pro-version.json"] = (json.dumps(candidate_metadata(original_version, commit), ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    output = output_dir / OUTPUT_NAME
    output.write_bytes(zip_bytes(entries))
    output_sha = file_digest(output)
    component_sha = digest(component)
    manifest = {
        "schema": 1,
        "sourceCommit": commit,
        "sourcePackage": SOURCE.name,
        "sourcePackageSha256": SOURCE_SHA256,
        "buildRevision": REVISION,
        "buildCommand": "py -3 dev/v405-client-yonetim-candidate/build_candidate.py --output-dir <dir>",
        "python": "3.x stdlib zipfile; DEFLATE level 9; fixed timestamp 2026-08-27T12:00:00",
        "artifacts": {
            output.name: output_sha,
            "pro-components/client-yonetim-pro.zip": component_sha,
        },
    }
    (output_dir / "SHA256SUMS.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output_dir / f"{output.name}.sha256.txt").write_text(f"{output_sha}  {output.name}\n", encoding="ascii")
    print(f"CANDIDATE={output}")
    print(f"SHA256={output_sha}")
    print(f"COMPONENT_SHA256={component_sha}")
    print(f"SOURCE_COMMIT={commit}")


if __name__ == "__main__":
    main()
