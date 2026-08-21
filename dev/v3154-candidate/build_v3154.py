from __future__ import annotations
import base64, hashlib, json, re, shutil, tarfile, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEV = Path(__file__).resolve().parent
BASE = ROOT / 'KafePin-Pro-Update-v3.1.53.zip'
OUT = ROOT / 'KafePin-Pro-Update-v3.1.54.zip'
SHA = ROOT / 'KafePin-Pro-Update-v3.1.54.sha256.txt'
LATEST = ROOT / 'latest.json'
REPORT_SRC = DEV / 'V3.1.54-CANDIDATE-TEST-REPORT.md'
REPORT_OUT = ROOT / 'V3.1.54-CANDIDATE-TEST-REPORT.md'
EXPECTED_DELTA_SHA = '7786c838498b9f3d980a2eb55cde6ab37ad2ad7f122bfa09a128a07bf232d207'
EXPECTED_SERVER_SHA = '8b51abf1aec0214b8ffaa1a425a952631151bf3d031013ce68dbb156e8ee425a'
FIXED_TIME = (2026, 8, 21, 10, 35, 0)

def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def patch_candidate2(build: Path) -> None:
    payload = build / 'v3154-yazici-payload'

    # One coherent build id across backend, launcher and health checks.
    for rel in ['web_service.py', 'KafePin_YaziciPRO_WebView2.ps1', 'START_YAZICI_PRO.cmd']:
        p = payload / rel
        s = p.read_text(encoding='utf-8-sig')
        s = s.replace('3.1.54-candidate1', '3.1.54-candidate2').replace('3154candidate1', '3154candidate2')
        p.write_text(s, encoding='utf-8-sig' if rel.endswith('.ps1') else 'utf-8')

    # Never fall back to an external browser. Yazici PRO must stay inside its WebView2 window.
    start = payload / 'START_YAZICI_PRO.cmd'
    s = start.read_text(encoding='utf-8-sig')
    old = '''if exist "%ROOT%KafePin_YaziciPRO_WebView2.ps1" (\n  start "KafePin Yazici PRO" powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%ROOT%KafePin_YaziciPRO_WebView2.ps1" -LocalUrl "http://127.0.0.1:17891/?v=3154candidate2"\n) else (\n  start "" "http://127.0.0.1:17891/?v=3154candidate2"\n)\nexit /b 0\n'''
    new = '''if exist "%ROOT%KafePin_YaziciPRO_WebView2.ps1" (\n  start "KafePin Yazici PRO" powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -File "%ROOT%KafePin_YaziciPRO_WebView2.ps1" -LocalUrl "http://127.0.0.1:17891/?v=3154candidate2"\n) else (\n  echo Yazici PRO WebView2 launcher bulunamadi.\n  echo Dis tarayici acilmadi; kurulumu yeniden uygula.\n  pause\n  exit /b 31\n)\nexit /b 0\n'''
    if old not in s:
        raise SystemExit('START external-browser fallback block not found')
    start.write_text(s.replace(old, new), encoding='utf-8')

    # Ensure both historical desktop shortcut spellings are overwritten to the same launcher.
    mgr = build / 'KafePin_Manager_Ensure.ps1'
    s = mgr.read_text(encoding='utf-8-sig').replace('3.1.54-candidate1', '3.1.54-candidate2').replace("build='candidate1'", "build='candidate2'")
    old_sc = "$lnk=Join-Path $desk 'KafePin Yazıcı PRO.lnk'; $sc=$shell.CreateShortcut($lnk); $sc.TargetPath=$startCmd; $sc.WorkingDirectory=$YaziciRoot; $sc.Description='KafePin Yazıcı PRO 3.1.54'; $sc.Save()"
    new_sc = "foreach ($shortcutName in @('KafePin Yazıcı PRO.lnk','KafePin Yazici PRO.lnk')) { $lnk=Join-Path $desk $shortcutName; $sc=$shell.CreateShortcut($lnk); $sc.TargetPath=$startCmd; $sc.WorkingDirectory=$YaziciRoot; $sc.Description='KafePin Yazıcı PRO 3.1.54'; $sc.Save() }"
    if old_sc not in s:
        raise SystemExit('desktop shortcut block not found')
    s = s.replace(old_sc, new_sc)
    mgr.write_text(s, encoding='utf-8-sig')

    # Correct stale JS guard naming; behavior is otherwise unchanged.
    html = payload / 'index.html'
    s = html.read_text(encoding='utf-8-sig').replace('__kafepinRevenue3153', '__kafepinRevenue3154')
    html.write_text(s, encoding='utf-8')

    vp = payload / 'yazici-pro-version.json'
    v = json.loads(vp.read_text(encoding='utf-8-sig'))
    v['version'] = '3.1.54'
    v['build'] = 'candidate2'
    fixes = list(v.get('fixes') or [])
    for item in ['both-desktop-shortcuts-webview2', 'no-external-browser-fallback', 'same-lan-mobile-qr', 'cancel-delete-actions']:
        if item not in fixes: fixes.append(item)
    v['fixes'] = fixes
    vp.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    up = build / 'update.json'
    u = json.loads(up.read_text(encoding='utf-8-sig'))
    u['notes'] = ("v3.1.54 ADAY / candidate2 — v3.1.49 STABLE tabanlı kümülatif güncelleme. "
                  "İptal onay penceresini kapatır ve satış oluşturmaz; Sil Son Yazdırmalar/onay bekleyen kaydı gerçekten kaldırır; Ücretsiz korunur. "
                  "Hem 'KafePin Yazıcı PRO' hem eski 'KafePin Yazici PRO' masaüstü kısayolu aynı WebView2 launcher'a zorla bağlanır. "
                  "WhatsApp Web yalnız Yazıcı PRO iç sekmesinde çalışır; dış tarayıcı fallback'i yoktur. "
                  "Fotoğraf Çek aynı ağda 5 dakikalık tek kullanımlık QR ile telefondan doğrudan ana makineye gönderir; diğer API'ler LAN'a kapalıdır. "
                  "EveryCafe salt-okunur ve STABLE v3.1.49 kalır.")
    up.write_text(json.dumps(u, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    # Payload changed above: refresh every embedded Manager SHA so install-time verification remains exact.
    s = mgr.read_text(encoding='utf-8-sig')
    for f in sorted(payload.rglob('*')):
        if not f.is_file(): continue
        src = str(f.relative_to(payload)).replace('/', '\\')
        pattern = re.compile(r"(Src='" + re.escape(src) + r"';\s*Dst='[^']+';\s*Sha=')[0-9a-fA-F]{64}(')")
        s, n = pattern.subn(lambda m: m.group(1) + sha(f.read_bytes()) + m.group(2), s, count=1)
        if n != 1:
            raise SystemExit('manager SHA pair not found: ' + src)
    mgr.write_text(s, encoding='utf-8-sig')

def main():
    if not BASE.exists(): raise SystemExit(f'base missing: {BASE}')
    parts = sorted(DEV.glob('delta.b64.part*'))
    encoded = ''.join(p.read_text(encoding='ascii').strip() for p in parts)
    delta = base64.b64decode(encoded, validate=True)
    if sha(delta) != EXPECTED_DELTA_SHA: raise SystemExit('delta SHA mismatch')

    with tempfile.TemporaryDirectory(prefix='kp3154-') as td:
        td = Path(td); tar_path = td/'delta.tar.gz'; tar_path.write_bytes(delta); build = td/'build'; build.mkdir()
        with tarfile.open(tar_path, 'r:gz') as tf: tf.extractall(build)
        with zipfile.ZipFile(BASE) as z: server = z.read('server.js')
        if sha(server) != EXPECTED_SERVER_SHA: raise SystemExit('server.js SHA mismatch')
        (build/'server.js').write_bytes(server)
        patch_candidate2(build)

        update = json.loads((build/'update.json').read_text(encoding='utf-8-sig'))
        assert update['version']=='3.1.54' and update['channel']=='candidate' and update['baseVersion']=='3.1.49' and update['cumulative'] is True
        files = update['files']; missing=[f for f in files if not (build/f).is_file()]
        if missing: raise SystemExit('missing files: '+repr(missing))

        if OUT.exists(): OUT.unlink()
        with zipfile.ZipFile(OUT,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for rel in files:
                info=zipfile.ZipInfo(rel,date_time=FIXED_TIME); info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=0o100644<<16
                z.writestr(info,(build/rel).read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
        with zipfile.ZipFile(OUT) as z:
            if z.namelist()!=files: raise SystemExit('zip manifest order mismatch')
            if z.testzip() is not None: raise SystemExit('zip corrupt')
        digest=sha(OUT.read_bytes()); SHA.write_text(f'{digest}  {OUT.name}\n',encoding='ascii')

    latest={'version':'3.1.54','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
      'publishedAt':'2026-08-21T10:35:00+03:00','notes':update['notes'],
      'downloadUrl':'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.54.zip','sha256':digest}
    LATEST.write_text(json.dumps(latest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    shutil.copyfile(REPORT_SRC,REPORT_OUT)
    print('V3154_BUILD_OK',digest,OUT.stat().st_size)

if __name__=='__main__': main()
