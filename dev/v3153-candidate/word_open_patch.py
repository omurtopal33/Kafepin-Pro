from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
html_path = ROOT / 'index.html'
svc_path = ROOT / 'web_service.py'

html = html_path.read_text(encoding='utf-8-sig')
svc = svc_path.read_text(encoding='utf-8-sig')

if 'v3153WordOpen' not in html:
    # Belge/Dilekce kartinin basligina, mevcut gorunumu bozmadan Word ac butonu ekle.
    patterns = [
        r'(<[^>]+>\s*Belge\s*/\s*Dilekçe\s*Hazırlama\s*</[^>]+>)',
        r'(<[^>]+>\s*Belge\s*/\s*Dilekce\s*Hazirlama\s*</[^>]+>)',
        r'(<[^>]+>\s*Belge\s+Hazırlama\s*</[^>]+>)',
        r'(<[^>]+>\s*Belge\s+Hazirlama\s*</[^>]+>)',
    ]
    match = None
    for pat in patterns:
        match = re.search(pat, html, flags=re.I)
        if match:
            break
    if not match:
        raise SystemExit('Belge / Dilekce Hazirlama basligi bulunamadi; Word butonu korlemesine eklenmedi.')

    button = '''\n<button id="v3153WordOpen" type="button" onclick="v3153OpenWord()" style="margin-left:10px;padding:9px 14px;border:1px solid #22c55e;border-radius:10px;background:#0f2e22;color:#eafff2;font-weight:800;cursor:pointer">📝 WORD AÇ</button>'''
    html = html[:match.end()] + button + html[match.end():]

    script = r'''
<script id="v3153-word-open-script">
async function v3153OpenWord(){
  const b=document.getElementById('v3153WordOpen');
  const old=b?b.textContent:'';
  try{
    if(b){b.disabled=true;b.textContent='WORD AÇILIYOR...';}
    const r=await fetch('/open-word',{method:'POST',headers:{'Content-Type':'application/json'}});
    const j=await r.json().catch(()=>({ok:false,error:'Word açılamadı'}));
    if(!r.ok || !j.ok) throw new Error(j.error || 'Word açılamadı');
    if(b)b.textContent='✓ WORD AÇILDI';
    setTimeout(()=>{if(b){b.disabled=false;b.textContent=old||'📝 WORD AÇ';}},1500);
  }catch(e){
    if(b){b.disabled=false;b.textContent=old||'📝 WORD AÇ';}
    alert('Microsoft Word açılamadı. Word kurulu mu kontrol et.\n\n'+(e&&e.message?e.message:e));
  }
}
</script>
'''
    if '</body>' not in html.lower():
        raise SystemExit('index.html body kapanisi bulunamadi')
    pos = html.lower().rfind('</body>')
    html = html[:pos] + script + html[pos:]

if 'v3153_open_word' not in svc:
    route = r'''

# v3.1.53 - Belge / Dilekce Hazirlama: Word'u yerel Windows oturumunda ac.
@app.route('/open-word', methods=['POST'])
def v3153_open_word():
    import subprocess
    try:
        # CREATE_NO_WINDOW yalniz cmd penceresini gizler; Word normal masaustu penceresi olarak acilir.
        creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        proc = subprocess.run(
            ['where.exe', 'winword.exe'],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=creationflags
        )
        if proc.returncode != 0:
            return {'ok': False, 'error': 'Microsoft Word (winword.exe) bulunamadi.'}, 404
        exe = (proc.stdout or '').splitlines()[0].strip()
        subprocess.Popen([exe], creationflags=0)
        return {'ok': True, 'app': 'Microsoft Word'}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}, 500
'''
    markers = ["if __name__ == '__main__':", 'if __name__ == "__main__":']
    idx = -1
    for marker in markers:
        idx = svc.find(marker)
        if idx >= 0:
            break
    if idx < 0:
        raise SystemExit('web_service.py main blogu bulunamadi; /open-word route guvenli yere eklenemedi.')
    svc = svc[:idx] + route + '\n' + svc[idx:]

html_path.write_text(html, encoding='utf-8')
svc_path.write_text(svc, encoding='utf-8')
print('WORD_OPEN_PATCH_OK')
