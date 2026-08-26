from pathlib import Path

p = Path('dev/v403-edevlet-candidate/build_v403_edevlet.py')
s = p.read_text(encoding='utf-8')

def one(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'{label}: expected 1 occurrence, found {n}')
    s = s.replace(old, new, 1)

one("from pathlib import Path\n", "from pathlib import Path\nfrom desktop_app_patch import patch_desktop_source\n", 'desktop patch import')
one("NESTED = 'pro-components/yazici-pro.zip'\nSUPERVISOR = 'KafePin_Update_Supervisor.js'\nALLOWED_OUTER = {'update.json', NESTED, SUPERVISOR}", "NESTED = 'pro-components/yazici-pro.zip'\nSUPERVISOR = 'KafePin_Update_Supervisor.js'\nDESKTOP = 'desktop-app/KafePinProDesktop.cs'\nALLOWED_OUTER = {'update.json', NESTED, SUPERVISOR, DESKTOP}", 'desktop outer allowlist')
one("        supervisor_bytes = outer.read(SUPERVISOR)\n        patched_supervisor = patch_supervisor(supervisor_bytes.decode('utf-8-sig')).encode('utf-8')", "        supervisor_bytes = outer.read(SUPERVISOR)\n        patched_supervisor = patch_supervisor(supervisor_bytes.decode('utf-8-sig')).encode('utf-8')\n        patched_desktop = patch_desktop_source(outer.read(DESKTOP))", 'desktop patch payload')
one("            update['files'] = [SUPERVISOR, NESTED]", "            update['files'] = [SUPERVISOR, NESTED, DESKTOP]", 'desktop update files')
one("                    elif info.filename == SUPERVISOR:\n                        data = patched_supervisor\n                    outz.writestr(info, data)", "                    elif info.filename == SUPERVISOR:\n                        data = patched_supervisor\n                    elif info.filename == DESKTOP:\n                        data = patched_desktop\n                    outz.writestr(info, data)", 'desktop outer write')
one("- Outer değişen girdiler: `update.json`, `KafePin_Update_Supervisor.js`, `pro-components/yazici-pro.zip`", "- Outer değişen girdiler: `update.json`, `KafePin_Update_Supervisor.js`, `pro-components/yazici-pro.zip`, `desktop-app/KafePinProDesktop.cs`", 'desktop report')
one("- `update.json files` yalnız `KafePin_Update_Supervisor.js` + `pro-components/yazici-pro.zip`; ana program dosyaları kopyalanmaz.", "- `update.json files` yalnız hedefli supervisor, Yazıcı PRO paketi ve gerekli ana masaüstü kaynak güncellemesidir; başka PRO/DB dosyası kopyalanmaz.", 'desktop report files')
one("                'v4.0.3 TEST/CANDIDATE2: hedefli hızlı güncelleme; ana masaüstü kabuğu ve diğer PRO modülleri refresh edilmez, yalnız Yazıcı PRO güncellenir.',", "                'v4.0.3 TEST/CANDIDATE3: yalnız ana masaüstünde gerekli Yazıcı PRO sekmesi ve e-Devlet iç WebView2 akışı güncellenir; diğer PRO modülleri/DB dosyaları değişmez.',", 'desktop candidate note')
one("- `server.js`, updater, rollback, DB güvenliği, EveryCafe, finans, session/spin ve diğer PRO paketleri byte-for-byte v4.0.2 ile aynıdır.", "- `server.js`, updater, rollback, DB güvenliği, EveryCafe, finans, session/spin ve diğer PRO paketleri byte-for-byte v4.0.2 ile aynıdır; yalnız desktop kaynağı ve Yazıcı PRO payloadı hedeflidir.", 'desktop protection report')
p.write_text(s, encoding='utf-8')
print('CANDIDATE3_DESKTOP_PATCH_OK')
