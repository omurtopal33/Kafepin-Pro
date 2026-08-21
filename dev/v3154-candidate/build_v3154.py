from __future__ import annotations
import base64, hashlib, json, shutil, tarfile, tempfile, zipfile
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
EXPECTED_ZIP_SHA = '2758a957e8c20516dc676f5e82fcc9438a1152a02cb80f9692ac93b1115abdef'
FIXED_TIME = (2026, 8, 21, 9, 55, 0)

def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def main():
    if not BASE.exists():
        raise SystemExit(f'base missing: {BASE}')
    parts = sorted(DEV.glob('delta.b64.part*'))
    if not parts:
        raise SystemExit('delta parts missing')
    encoded = ''.join(p.read_text(encoding='ascii').strip() for p in parts)
    delta = base64.b64decode(encoded, validate=True)
    if sha(delta) != EXPECTED_DELTA_SHA:
        raise SystemExit('delta SHA mismatch')

    with tempfile.TemporaryDirectory(prefix='kp3154-') as td:
        td = Path(td)
        tar_path = td / 'delta.tar.gz'
        tar_path.write_bytes(delta)
        build = td / 'build'
        build.mkdir()
        with tarfile.open(tar_path, 'r:gz') as tf:
            tf.extractall(build)
        with zipfile.ZipFile(BASE) as z:
            server = z.read('server.js')
        if sha(server) != EXPECTED_SERVER_SHA:
            raise SystemExit('server.js SHA mismatch')
        (build / 'server.js').write_bytes(server)

        update = json.loads((build/'update.json').read_text(encoding='utf-8-sig'))
        assert update['version'] == '3.1.54'
        assert update['channel'] == 'candidate'
        assert update['baseVersion'] == '3.1.49'
        assert update['cumulative'] is True
        files = update['files']
        if files[0] != 'server.js' or 'KafePin_Manager_Ensure.ps1' not in files:
            raise SystemExit('manifest invalid')
        missing = [f for f in files if not (build/f).is_file()]
        if missing:
            raise SystemExit('missing files: '+repr(missing))

        if OUT.exists(): OUT.unlink()
        with zipfile.ZipFile(OUT,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
            for rel in files:
                info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                z.writestr(info, (build/rel).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=6)
        with zipfile.ZipFile(OUT) as z:
            if z.namelist() != files: raise SystemExit('zip manifest order mismatch')
            if z.testzip() is not None: raise SystemExit('zip corrupt')
        digest=sha(OUT.read_bytes())
        if digest != EXPECTED_ZIP_SHA:
            raise SystemExit(f'final ZIP SHA mismatch: {digest}')
        SHA.write_text(f'{digest}  {OUT.name}\n', encoding='ascii')

    latest={
      'version':'3.1.54','channel':'candidate','stableVersion':'3.1.49','baseVersion':'3.1.49','cumulative':True,
      'publishedAt':'2026-08-21T09:55:00+03:00',
      'notes':'v3.1.54 ADAY — v3.1.49 STABLE tabanlı kümülatif güncelleme. İptal onay penceresini kapatır ve satış oluşturmaz; Sil ham Son Yazdırmalar ve onay bekleyen kayıtları kaldırır; Ücretsiz korunur. WhatsApp Web yalnız Yazıcı PRO\'nun kendi WebView2 sekmesinde çalışır. Fotoğraf Çek aynı ağda süreli/tek kullanımlık QR ile telefondan doğrudan ana makineye gelir; diğer API\'ler LAN\'a kapalıdır. Belge/Dilekçe & AI ve açık finans onayı korunur. EveryCafe salt-okunur; STABLE v3.1.49.',
      'downloadUrl':'https://raw.githubusercontent.com/omurtopal33/Kafepin-Pro/main/KafePin-Pro-Update-v3.1.54.zip',
      'sha256':EXPECTED_ZIP_SHA,
    }
    LATEST.write_text(json.dumps(latest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    shutil.copyfile(REPORT_SRC, REPORT_OUT)
    print('V3154_BUILD_OK', EXPECTED_ZIP_SHA, OUT.stat().st_size)

if __name__=='__main__': main()
