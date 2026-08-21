from __future__ import annotations
import hashlib, json, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "KafePin-Pro-Update-v3.1.57.zip"
OUT = ROOT / "KafePin-Pro-Update-v3.1.58.zip"
SHA_FILE = ROOT / "KafePin-Pro-Update-v3.1.58.sha256.txt"
LATEST = ROOT / "latest.json"
REPORT = ROOT / "V3.1.58-CANDIDATE-TEST-REPORT.md"
FIXED_DT = (2026, 8, 21, 12, 8, 0)

PRECHECK = '''    try {\n      ensureKafePinManagerReadySync();\n    } catch (managerErr) {\n      const message = String(managerErr.message || managerErr);\n      writeProUpdateState("error", `Server Manager on-kontrolu basarisiz: ${message}`, { version: status.latestVersion });\n      addLiveLog("pro_update", `⚠️ Guncelleme baslatilmadi • Server Manager hazir degil: ${message.slice(0, 150)}`);\n      return res.status(500).json({ ok: false, error: `Server Manager hazir degil: ${message}` });\n    }\n\n'''
REPLACEMENT = '''    // v3.1.58: Guncelleme BASLAMADAN eski Manager'i on-kosul olarak calistirma.\n    // Eski/bayat Manager yeni paketin indirilmesini engelleyemez. Paket once\n    // indirilip SHA256 ile dogrulanir; tum yeni dosyalar (yeni Manager dahil)\n    // C:\\KafePin'e kopyalandiktan SONRA yeni Manager dogrulanip baslatilir.\n\n'''

def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def build():
    if not BASE.exists(): raise SystemExit('v3.1.57 base package missing')
    with tempfile.TemporaryDirectory(prefix='kp3158-') as td:
        work=Path(td)/'work'; work.mkdir()
        with zipfile.ZipFile(BASE,'r') as z: z.extractall(work)
        server_path=work/'server.js'; server=server_path.read_text(encoding='utf-8-sig')
        if PRECHECK not in server: raise SystemExit('pre-update manager precheck block not found')
        server=server.replace(PRECHECK,REPLACEMENT,1)
        handler=server[server.index('app.post("/admin/pro/apply-update"'):server.index('// Internet olmadiginda da ayni guvenli akis')]
        if 'Server Manager on-kontrolu basarisiz' in handler: raise SystemExit('manager precheck still blocks apply-update')
        if 'ensureKafePinManagerReadySync();' in handler: raise SystemExit('manager ensure still present before package apply')
        apply=server[server.index('function applyPreparedUpdateDirect'):server.index('// Eski fonksiyon adi korunuyor')]
        copy_idx=apply.index('for (const rel of files) {')
        ensure_idx=apply.index('ensureKafePinManagerReadySync();')
        if ensure_idx <= copy_idx: raise SystemExit('manager ensure is not after package copy')
        server_path.write_text(server,encoding='utf-8')

        meta_path=work/'update.json'; meta=json.loads(meta_path.read_text(encoding='utf-8-sig'))
        meta.update({
            'version':'3.1.58','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
            'notes':'v3.1.58 updater bootstrap düzeltmesi: eski/bayat KafePin_Manager_Ensure.ps1 artık güncelleme paketinin indirilmesini engelleyemez; paket SHA doğrulanır, yeni Manager önce diske yazılır, Manager sonra çalıştırılır.'
        })
        files=sorted(str(p.relative_to(work)).replace('\\','/') for p in work.rglob('*') if p.is_file())
        meta['files']=files; meta_path.write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        files=sorted(str(p.relative_to(work)).replace('\\','/') for p in work.rglob('*') if p.is_file())
        if OUT.exists(): OUT.unlink()
        with zipfile.ZipFile(OUT,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
            for rel in files:
                p=work/rel; zi=zipfile.ZipInfo(rel,FIXED_DT); zi.compress_type=zipfile.ZIP_DEFLATED; zi.external_attr=0o644<<16; z.writestr(zi,p.read_bytes())
    digest=sha256_file(OUT)
    SHA_FILE.write_text(f'{digest}  {OUT.name}\n',encoding='utf-8')
    LATEST.write_text(json.dumps({
        'version':'3.1.58','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
        'publishedAt':'2026-08-21T12:08:00+03:00',
        'notes':'v3.1.58 ADAY — updater bootstrapping düzeltmesi. Eski Manager yeni güncellemeyi bloke edemez; yeni paket/Manager önce kurulur, Manager doğrulaması sonra yapılır.',
        'downloadUrl':'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.58.zip','sha256':digest
    },ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    REPORT.write_text('# KafePin Pro v3.1.58 ADAY — Updater Bootstrap Düzeltmesi\n\n- STABLE: **3.1.49**\n- Aday: **3.1.58**\n- Hedef saha hatası: eski v3.1.56 `KafePin_Manager_Ensure.ps1` daha yeni paket indirilmeden önce çalışıp `yazici-pro-version.json` SHA hatasıyla güncellemeyi bloke ediyor.\n- Tasarım: `/admin/pro/apply-update` artık eski Manager ön-kontrolü yapmaz. ZIP indirilir ve SHA256 doğrulanır; paket dosyaları, yeni Manager dahil, diske yazılır; Manager yalnız bundan sonra çalıştırılır.\n- Tek-seferlik saha kilidi açıcı: `KafePin-UPDATE-UNLOCK-v3.1.58.ps1`.\n- Windows test sonuçları CI tamamlanınca güncellenecek.\n- Paket SHA256: `'+digest+'`\n',encoding='utf-8')
    print('V3158_BUILD_OK',digest,OUT.stat().st_size)

if __name__=='__main__': build()
