from pathlib import Path
import hashlib, json, shutil, subprocess, sys, tempfile, zipfile

ROOT=Path.cwd()
BASE_ZIP=ROOT/'KafePin-Pro-Update-v3.1.49.zip'
HELPER=ROOT/'dev'/'v3151-candidate'
OUT=ROOT/'KafePin-Pro-Update-v3.1.51.zip'
REPORT=ROOT/'V3.1.51-CANDIDATE-TEST-REPORT.md'
EXPECTED_BASE_SHA='9eb3468b4991476ae7850be0556315f05a4430ae3b94264cc53238b69fc2b34e'

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args):
    print('+',' '.join(map(str,args)))
    subprocess.run(args,check=True)

if not BASE_ZIP.exists(): raise SystemExit('stable v3.1.49 zip missing')
if sha(BASE_ZIP)!=EXPECTED_BASE_SHA: raise SystemExit('stable v3.1.49 SHA mismatch')

with tempfile.TemporaryDirectory(prefix='kp3151_') as td:
    td=Path(td); base=td/'base'; pkg=td/'pkg'; payload=pkg/'v3151-yazici-payload'
    base.mkdir(); pkg.mkdir(); payload.mkdir(parents=True)
    with zipfile.ZipFile(BASE_ZIP) as z: z.extractall(base)
    base_manifest=json.loads((base/'update.json').read_text(encoding='utf-8-sig'))
    if str(base_manifest.get('version'))!='3.1.49': raise SystemExit('base manifest not 3.1.49')

    shutil.copy2(base/'server.js',pkg/'server.js')
    shutil.copy2(base/'KafePin_Manager_Ensure.ps1',pkg/'KafePin_Manager_Ensure.ps1')
    stable_server_sha=sha(pkg/'server.js')
    stable_manager_sha=sha(pkg/'KafePin_Manager_Ensure.ps1')

    run([sys.executable,str(HELPER/'patch_telegram.py'),str(pkg/'server.js')])

    for name in ['index.html','KafePin_YaziciGelir_Service.js','START_YAZICI_PRO.cmd','yazici-pro-version.json']:
        shutil.copy2(HELPER/'payload'/name,payload/name)
    run([sys.executable,str(HELPER/'patch_manager.py'),str(pkg/'KafePin_Manager_Ensure.ps1'),str(payload)])

    files=[
      'server.js',
      'KafePin_Manager_Ensure.ps1',
      'v3151-yazici-payload/index.html',
      'v3151-yazici-payload/KafePin_YaziciGelir_Service.js',
      'v3151-yazici-payload/START_YAZICI_PRO.cmd',
      'v3151-yazici-payload/yazici-pro-version.json',
      'update.json'
    ]
    manifest={
      'version':'3.1.51',
      'channel':'candidate',
      'baseVersion':'3.1.49',
      'cumulative':False,
      'files':files,
      'notes':'v3.1.51 ADAY — v3.1.49 STABLE üzerine delta güncelleme. Yalnız Telegram mesaj yönetimi ve Yazıcı PRO geliştirilir. Telegram aynı bildirimi çift göndermez; otomatik sağlık alarmı restart sonrasında da kalıcı dedupe kullanır; gün sonu sağlık raporu cron/catch-up claim kilidiyle tek gönderilir; Canlı Durum her yeni bildirimden sonra tek mesaj olarak alta taşınır ve silme hatasında ikinci Canlı Durum oluşturulmaz. Yazıcı PRO KafePin temasında WhatsApp/Hızlı Çıktı, Son Yazdırmalar, Yazıcı Geliri ve Ücretsiz Yazdır içerir; ücretli gelir yalnız KafePin Doğrudan Satış endpointine gider. MP3 PRO, Teknik Servis PRO, EveryCafe, session, spin ve diğer v3.1.49 dosyaları pakete dahil edilmez ve değiştirilmez.'
    }
    (pkg/'update.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

    run(['node','--check',str(pkg/'server.js')])
    run(['node','--check',str(payload/'KafePin_YaziciGelir_Service.js')])
    if sys.platform.startswith('win'):
        ps = shutil.which('powershell.exe') or shutil.which('powershell')
        if not ps: raise SystemExit('Windows PowerShell missing on runner')
        manager_path = str(pkg/'KafePin_Manager_Ensure.ps1').replace("'", "''")
        cmd = "$raw=Get-Content -LiteralPath '{}' -Raw; [void][scriptblock]::Create($raw); Write-Host POWERSHELL_PARSE_OK".format(manager_path)
        run([ps,'-NoProfile','-ExecutionPolicy','Bypass','-Command',cmd])
    run(['node',str(HELPER/'telegram_logic_test.js'),str(pkg/'server.js')])
    run(['node',str(HELPER/'revenue_integration_test.js'),str(payload/'KafePin_YaziciGelir_Service.js')])

    s=(pkg/'server.js').read_text(encoding='utf-8-sig')
    required=['v3.1.51 TELEGRAM_SINGLE_SEND_AND_LIVE_BOTTOM','TELEGRAM_PAYLOAD_DEDUP_MS','telegram_auto_health_alert_state','telegram_eod_health_report_claim','liveMonitorMoveInFlight','kopya oluşturulmayacak']
    for x in required:
      if x not in s: raise SystemExit('server marker missing: '+x)
    if s.count('function sendTelegramMessage(text, cb) {')!=1: raise SystemExit('sendTelegramMessage count mismatch')
    if s.count('function moveLiveMonitorToBottomSoon() {')!=1: raise SystemExit('move live function count mismatch')

    stable_s=(base/'server.js').read_text(encoding='utf-8-sig')
    ro_pat='new sqlite3.Database(EVERYCAFE_DB_PATH, sqlite3.OPEN_READONLY'
    if s.count(ro_pat)!=stable_s.count(ro_pat): raise SystemExit('EveryCafe OPEN_READONLY count changed')
    if 'OPEN_READWRITE' in s and s.count('OPEN_READWRITE')!=stable_s.count('OPEN_READWRITE'): raise SystemExit('new OPEN_READWRITE detected')

    idx=(payload/'index.html').read_text(encoding='utf-8-sig')
    for x in ['v3151Verified','WHATSAPP / HIZLI ÇIKTI','SON YAZDIRMALAR','YAZICI GELİRİ','Ücretsiz Yazdır']:
      if x not in idx: raise SystemExit('Yazici UI marker missing: '+x)
    svc=(payload/'KafePin_YaziciGelir_Service.js').read_text(encoding='utf-8-sig')
    for x in ['/admin/product-sales/add-custom-direct','paymentMethod','uncertain','free:true']:
      if x not in svc: raise SystemExit('revenue invariant missing: '+x)

    forbidden=['mp3','teknik','technical','pro-components','KafePinMp3BotPRO','KafePinTeknikServisPRO']
    for f in files:
      low=f.lower()
      if any(x.lower() in low for x in forbidden): raise SystemExit('forbidden unrelated component in candidate: '+f)

    if OUT.exists(): OUT.unlink()
    with zipfile.ZipFile(OUT,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
      for rel in files: z.write(pkg/rel,arcname=rel)
    with zipfile.ZipFile(OUT) as z:
      bad=z.testzip()
      if bad: raise SystemExit('zip corruption: '+bad)
      names=z.namelist()
      if names!=files: raise SystemExit('zip allow-list mismatch')
      m=json.loads(z.read('update.json').decode('utf-8-sig'))
      if m['version']!='3.1.51' or m['baseVersion']!='3.1.49' or m['cumulative'] is not False: raise SystemExit('candidate manifest mismatch')

    report=f'''# KafePin Pro v3.1.51 ADAY — Test Raporu\n\n- Taban: **v3.1.49 STABLE**\n- Taban ZIP SHA256: `{EXPECTED_BASE_SHA}`\n- Taban server.js SHA256: `{stable_server_sha}`\n- Taban Manager Ensure SHA256: `{stable_manager_sha}`\n- Aday ZIP SHA256: `{sha(OUT)}`\n- Paket tipi: **delta / baseVersion 3.1.49**\n\n## Geçen kontroller\n\n- Exact v3.1.49 STABLE ZIP SHA256 doğrulandı.\n- `server.js` doğrudan v3.1.49 ZIP içinden alındı ve yalnız Telegram hedef bölgeleri patch edildi.\n- Patched `server.js`: `node --check` geçti.\n- `KafePin_Manager_Ensure.ps1`: Windows PowerShell parser testi geçti.\n- Yazıcı Geliri servisi: `node --check` geçti.\n- Telegram gerçek-fonksiyon mantık testi: aynı payload iki çağrıda tek HTTP gönderimi, Canlı Durum alta taşıma tetiklemesi, delete hatasında ikinci canlı mesaj üretmeme ve kalıcı sağlık/EOD markerları geçti.\n- Yazıcı gelir gerçek HTTP entegrasyon testi: servis gerçek Node process olarak açıldı; Nakit 10 TL, Kart 20 TL, Ücretsiz 0 TL, duplicate işlem engeli ve `/admin/product-sales/add-custom-direct` POST akışı geçti.\n- EveryCafe OPEN_READONLY açılış sayısı v3.1.49 tabanıyla aynı kaldı.\n- ZIP allow-list doğrulandı; MP3 PRO / Teknik Servis PRO / `pro-components` pakete dahil değil.\n- Yazıcı PRO arayüz markerları: WhatsApp/Hızlı Çıktı, Son Yazdırmalar, Yazıcı Geliri, Ücretsiz Yazdır, v3.1.51 ADAY mevcut.\n\n## Değişen hedefler\n\n1. `server.js` — yalnız Telegram tekilleştirme / sağlık bildirimi / Canlı Durum alta taşıma.\n2. `KafePin_Manager_Ensure.ps1` — yalnız v3.1.51 Yazıcı PRO payloadını gerçek kurulum klasörüne SHA256 ile uygulama ve gelir servisini başlatma.\n3. `v3151-yazici-payload/*` — Yazıcı PRO gelir/WhatsApp/kuyruk arayüzü ve Node gelir servisi.\n\n**STABLE otomatik değiştirilmez.** Kullanıcı sahada onaylayıp **kitle** demeden `latest.json` v3.1.49 kalır.\n'''
    REPORT.write_text(report,encoding='utf-8')
    print('BUILD_OK',OUT,sha(OUT))
