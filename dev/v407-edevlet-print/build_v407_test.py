from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BASE_NAME = "KafePin-Pro-Update-v4.0.6-STABLE.zip"
CANDIDATE_NAME = "KafePin-Pro-Update-v4.0.7-TEST-EDEVLET-PRINT-TOTAL-R1.zip"
BASE = ROOT / BASE_NAME
EXPECTED_BASE_SIZE = 835933
EXPECTED_BASE_SHA256 = "f6446ef5538eec9cd2cb4df2c6d72efc702b02df329e293333506e41ec74a6a4"
FIXED_TIME = (2026, 8, 28, 10, 0, 0)
METADATA_FILES = {"update.json", "kafepin-pro-version.json"}
TARGET_FILES = ["KafePin_Update_Supervisor.js", "pro-components/yazici-pro.zip"]
YAZICI_ARCHIVE = "pro-components/yazici-pro.zip"
YAZICI_CHANGED_FILES = {"KafePin_YaziciGelir_Service.js", "yazici-pro-version.json"}
EXPECTED_BASE_YAZICI_SHA256 = "280d28f909604a4647c1d3b64a208505aea34ff18893f26ca7f31b01f4c63df7"


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


def test_metadata(source: dict) -> dict:
    result = dict(source)
    for key in ("promotedFromArtifact", "promotedFromSha256", "payloadChanged"):
        result.pop(key, None)
    result.update(
        {
            "version": "4.0.7",
            "channel": "test",
            "finalStable": False,
            "stableBase": "3.1.64",
            "baseVersion": "3.1.64",
            "futureUpdateBase": "3.1.64",
            "cumulative": True,
            "sourceVersion": "4.0.6",
            "sourceSha256": EXPECTED_BASE_SHA256,
            "publishedAt": "2026-08-28T10:00:00+03:00",
            "notes": [
                "v4.0.7 TEST R1: v4.0.6 paketinde mevcut olan doğru Yazıcı PRO payloadı, aynı 3.1.61 metadata etiketli eski canlı dosyanın atlanmaması için mevcut hedefli repair akışıyla yeniden uygulanır.",
                "e-Devlet oturumunda Windows PrintService baskıları mevcut Yazıcı PRO fiyatıyla yeşil canlı toplamı artırır; aynı EventRecordID ikinci kez ücret oluşturmaz.",
                "Bu yalnız TEST candidate paketidir; saha doğrulaması ve kullanıcı onayı olmadan STABLE/FINAL değildir.",
            ] + [str(note) for note in source.get("notes") or []],
            "files": TARGET_FILES,
            "buildRevision": "v407-test-edevlet-print-payload-repair-r1",
            "mode": "test",
            "installedAt": "",
            "baseStableTag": "v4.0.6-stable",
            "baseStableCommit": "9590ac7f4b034bdbce48f080ade9b10246823fd0",
            "baseStableArtifact": BASE_NAME,
            "baseStableArtifactSha256": EXPECTED_BASE_SHA256,
            "payloadSourceUnchanged": False,
            "targetedPayloadChange": "Yazici PRO e-Devlet pending PrintService recovery",
        }
    )
    return result


def patch_revenue_service(source: bytes) -> bytes:
    text = source.decode("utf-8-sig")
    replacement = r'''function activeEdevletSession(s){
  return Object.values(s.transactions||{}).filter(tx=>tx&&tx.status==="pending_confirmation"&&tx.meta&&tx.meta.service_type==="edevlet"&&tx.meta.active_session===true).sort((a,b)=>String(b.created_at||"").localeCompare(String(a.created_at||"")))[0]||null;
}
function printEventTime(row){
  const value=Date.parse(String(row&&row.time||row&&row.created_at||"")); return Number.isFinite(value)?value:0;
}
function pollQueue(){
  const s=state(); const ev=readEvents(); const max=ev.reduce((m,e)=>Math.max(m,e.record_id),0);
  if(!s.initialized){ s.initialized=true; s.lastSeenRecordId=max; }
  else {
    for(const e of ev){ if(e.record_id<=s.lastSeenRecordId) continue; const k=String(e.record_id); if(!s.jobs[k]) s.jobs[k]={...e,status:"pending",created_at:new Date().toISOString()}; }
    s.lastSeenRecordId=Math.max(s.lastSeenRecordId,max);
  }
  saveState(s);
  const active=activeEdevletSession(s);
  if(active){
    const existing=new Set((active.record_ids||[]).map(Number)),started=Date.parse(String(active.created_at||""))||0;
    const recoverable=Object.values(s.jobs||{}).filter(job=>job&&job.status==="pending"&&!existing.has(Number(job.record_id))&&(!started||printEventTime(job)>=Math.max(0,started-2000)));
    if(recoverable.length){
      try{const updated=appendPrintJobsToTransaction(active.id,recoverable,"bw",active.payment_method||"CASH");log(`e-Devlet canlı/bekleyen çıktı eklendi: count=${recoverable.length} total=${updated.total}`);}
      catch(e){log("e-Devlet canlı çıktı ekleme hatası: "+e.message);}
    }
  }
  return state();
}
function maxRecordId'''
    patched, count = re.subn(r"function pollQueue\(\)\{[\s\S]*?\r?\n\}\r?\nfunction maxRecordId", replacement, text, count=1)
    if count != 1:
        raise SystemExit("Locked Yazici revenue pollQueue boundary mismatch")
    return patched.encode("utf-8")


def build_yazici_archive(source: bytes) -> tuple[bytes, str]:
    if hashlib.sha256(source).hexdigest() != EXPECTED_BASE_YAZICI_SHA256:
        raise SystemExit("Locked v4.0.6 Yazici PRO payload SHA mismatch")
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Locked v4.0.6 Yazici PRO payload is corrupt")
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries["KafePin_YaziciGelir_Service.js"] = patch_revenue_service(entries["KafePin_YaziciGelir_Service.js"])
    version = json.loads(entries["yazici-pro-version.json"].decode("utf-8-sig"))
    version["version"] = "3.1.62"
    version["build"] = "v407-edevlet-print-recovery-r1"
    fixes = [str(value) for value in version.get("fixes") or []]
    for marker in ("edevlet-live-print-total", "edevlet-pending-print-recovery", "edevlet-print-eventrecordid-idempotency"):
        if marker not in fixes:
            fixes.append(marker)
    version["fixes"] = fixes
    entries["yazici-pro-version.json"] = (json.dumps(version, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    result = zip_bytes(entries)
    return result, hashlib.sha256(result).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    if not BASE.is_file() or BASE.stat().st_size != EXPECTED_BASE_SIZE:
        raise SystemExit("Locked v4.0.6 STABLE base size mismatch")
    if sha256_file(BASE) != EXPECTED_BASE_SHA256:
        raise SystemExit("Locked v4.0.6 STABLE base SHA-256 mismatch")

    with zipfile.ZipFile(BASE) as archive:
        if archive.testzip() is not None:
            raise SystemExit("Locked v4.0.6 STABLE base is corrupt")
        entries = {name: archive.read(name) for name in archive.namelist()}

    entries[YAZICI_ARCHIVE], yazici_sha = build_yazici_archive(entries[YAZICI_ARCHIVE])

    for name in METADATA_FILES:
        source_metadata = json.loads(entries[name].decode("utf-8-sig"))
        entries[name] = (json.dumps(test_metadata(source_metadata), ensure_ascii=False, indent=2) + "\n").encode("utf-8")

    candidate = output_dir / CANDIDATE_NAME
    candidate.write_bytes(zip_bytes(entries))
    candidate_sha = sha256_file(candidate)
    manifest = {
        "schema": 1,
        "version": "4.0.7",
        "channel": "test",
        "finalStable": False,
        "baseStableArtifact": BASE_NAME,
        "baseStableArtifactSize": EXPECTED_BASE_SIZE,
        "baseStableArtifactSha256": EXPECTED_BASE_SHA256,
        "candidateArtifact": CANDIDATE_NAME,
        "candidateArtifactSize": candidate.stat().st_size,
        "candidateArtifactSha256": candidate_sha,
        "changedArchiveMembers": sorted(METADATA_FILES | {YAZICI_ARCHIVE}),
        "changedYaziciMembers": sorted(YAZICI_CHANGED_FILES),
        "yaziciPayloadSha256": yazici_sha,
        "targetedInstallFiles": TARGET_FILES,
        "nonTargetPayloadMembersUnchanged": True,
        "databasePayloadPresent": False,
        "build": "Windows Python 3.13.15 stdlib zipfile, DEFLATE level 9, fixed timestamp 2026-08-28T10:00:00",
    }
    (output_dir / "V4.0.7-TEST-SHA256SUMS.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / f"{CANDIDATE_NAME}.sha256.txt").write_text(f"{candidate_sha}  {CANDIDATE_NAME}\n", encoding="ascii")
    print(f"BASE_SHA256={EXPECTED_BASE_SHA256}")
    print(f"CANDIDATE={candidate}")
    print(f"CANDIDATE_SIZE={candidate.stat().st_size}")
    print(f"CANDIDATE_SHA256={candidate_sha}")


if __name__ == "__main__":
    main()
