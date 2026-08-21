(()=>{
  'use strict';
  if(window.__kafepinAI3155)return;
  window.__kafepinAI3155=true;
  const q=s=>document.querySelector(s);
  const post=async(path,data={})=>{
    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const j=await r.json().catch(()=>({ok:false,error:'Geçersiz cevap'}));
    if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));
    return j;
  };
  const get=async(path)=>{
    const r=await fetch(path,{cache:'no-store'});
    const j=await r.json().catch(()=>({ok:false,error:'Geçersiz cevap'}));
    if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));
    return j;
  };
  const setStatus=(text,bad=false)=>{const e=q('#status');if(e){e.textContent=text;e.style.color=bad?'#ff9aa5':'#b7d9ea'}};
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ai=q('#ai3153'), tab=q('#ai3153Tab'), text=q('#ai3153Text'), source=q('#ai3153Source'), sourceEmpty=q('#ai3153SourceEmpty');
  if(!ai||!tab||!text)return;

  function activate(){
    document.querySelectorAll('.mode').forEach(x=>x.classList.remove('visible'));
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    ai.classList.add('visible');tab.classList.add('active');refreshState();
  }
  tab.addEventListener('click',activate);
  document.querySelectorAll('.tab').forEach(t=>{if(t!==tab)t.addEventListener('click',()=>ai.classList.remove('visible'))});

  function openWhatsApp(){
    try{
      if(window.chrome?.webview?.postMessage){window.chrome.webview.postMessage('open-whatsapp');return true}
    }catch{}
    setStatus('WhatsApp Web yalnız Yazıcı PRO masaüstü penceresinin iç sekmesinde çalışır. Yazıcı PRO kısayolundan yeniden aç.',true);
    return false;
  }
  function deviceCfg(){return{scanner_id:q('#scanner')?.value||'',dpi:+(q('#dpi')?.value||300),color_mode:q('#colorMode')?.value==='gray'?'gray':'color',printer:q('#printer')?.value||'',identity_layout:document.querySelector('input[name=layout]:checked')?.value||'side_by_side'}}
  function uncertainCount(v){return (String(v||'').match(/\[\[[^\]]+\]\]/g)||[]).length}
  function renderUncertain(){const n=uncertainCount(text.value);const e=q('#ai3153Uncertain');if(e)e.textContent=n?`⚠️ ${n} şüpheli / kontrol edilecek alan`:'✓ İşaretli şüpheli alan yok';}
  text.addEventListener('input',renderUncertain);

  async function refreshState(){
    try{
      const d=await get('/api/ai/state');
      text.value=d.text||'';
      q('#ai3153AutoClear').checked=d.auto_clear!==false;
      const k=q('#ai3153KeyState');
      if(k)k.textContent=d.api_key_ready?`AI hazır${d.model?' • '+d.model:''}`:'AI anahtarı ayarlı değil';
      if(d.source_ready){source.hidden=false;source.src='/api/ai/source?_='+Date.now();sourceEmpty.hidden=true}
      else{source.hidden=true;source.removeAttribute('src');sourceEmpty.hidden=false}
      renderUncertain();
    }catch(e){setStatus('AI durumu: '+e.message,true)}
  }

  async function uploadFile(file){
    if(!file)return;
    const fd=new FormData();fd.append('image',file,file.name||'foto.jpg');
    setStatus('AI görseli hazırlanıyor…');
    const r=await fetch('/api/ai/upload',{method:'POST',body:fd});
    const j=await r.json().catch(()=>({ok:false,error:'Geçersiz cevap'}));
    if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));
    await refreshState();setStatus('Görsel hazır. Şimdi 🤖 METNE ÇEVİR seç.');
  }

  q('#ai3153PhotoToWord').onclick=()=>q('#ai3153File').click();
  q('#ai3153PhotoPick').onclick=()=>q('#ai3153File').click();
  let mobileToken='', mobilePoll=null;
  function closeMobile(){const m=q('#ai3155Mobile');if(m)m.style.display='none';if(mobilePoll){clearInterval(mobilePoll);mobilePoll=null}}
  q('#ai3155MobileClose').onclick=closeMobile;
  q('#ai3153Camera').onclick=async()=>{
    try{
      setStatus('Aynı ağ için QR hazırlanıyor…');
      const d=await post('/api/ai/mobile-capture/start'); mobileToken=d.token||'';
      q('#ai3155MobileQr').src=(d.qr_url||'')+'&_='+Date.now();
      q('#ai3155MobileUrl').textContent=d.url||'';
      q('#ai3155Mobile').style.display='flex';
      setStatus('QR hazır. Telefon aynı Wi‑Fi/LAN ağındayken okut ve fotoğrafı gönder.');
      if(mobilePoll)clearInterval(mobilePoll);
      mobilePoll=setInterval(async()=>{
        try{const st=await get('/api/ai/mobile-capture/status?token='+encodeURIComponent(mobileToken));
          if(st.uploaded){closeMobile();await refreshState();setStatus('Telefon fotoğrafı alındı. Şimdi 🤖 METNE ÇEVİR seç.')}
          else if((st.expires_in||0)<=0){closeMobile();setStatus('QR süresi doldu. Fotoğraf Çek ile yeni QR oluştur.',true)}
        }catch(e){closeMobile();setStatus(e.message,true)}
      },1000);
    }catch(e){setStatus(e.message,true)}
  };
  q('#ai3153File').onchange=()=>uploadFile(q('#ai3153File').files?.[0]).catch(e=>setStatus(e.message,true));

  q('#ai3153Scan').onclick=async()=>{
    const cfg=deviceCfg();if(!cfg.scanner_id){setStatus('Önce tarayıcı seç.',true);return}
    try{setStatus('Belge AI için taranıyor…');await post('/api/config',cfg);await post('/api/scan/ai',cfg);await refreshState();setStatus('Tarama hazır. Şimdi 🤖 METNE ÇEVİR seç.')}
    catch(e){setStatus(e.message,true)}
  };

  q('#ai3153WhatsappPick').onclick=async()=>{
    const box=q('#ai3153Downloads');
    try{
      const d=await get('/api/ai/downloads'), rows=d.files||[];
      box.hidden=false;
      box.innerHTML=rows.length?rows.map(f=>`<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px;border-bottom:1px solid #294356"><span><b>${esc(f.name)}</b><br><small>${Math.max(1,Math.round((f.size||0)/1024))} KB</small></span><button class="btn ai3153Dl" data-name="${esc(f.name)}" type="button">SEÇ</button></div>`).join(''):'İndirilenler içinde son görsel bulunamadı.';
      box.querySelectorAll('.ai3153Dl').forEach(b=>b.onclick=async()=>{try{await post('/api/ai/from-downloads',{name:b.dataset.name});box.hidden=true;await refreshState();setStatus('WhatsApp/İndirilenler görseli hazır.')}catch(e){setStatus(e.message,true)}});
    }catch(e){box.hidden=false;box.textContent=e.message;setStatus(e.message,true)}
  };

  q('#ai3153Extract').onclick=async()=>{
    const b=q('#ai3153Extract');if(b.classList.contains('busy'))return;b.classList.add('busy');const old=b.textContent;b.textContent='🤖 OKUYOR…';
    try{setStatus('AI görseldeki yazıyı metne çeviriyor…');const d=await post('/api/ai/extract');text.value=d.text||'';renderUncertain();const k=q('#ai3153KeyState');if(k)k.textContent=`AI hazır • ${d.model||'model'}`;setStatus('Metin hazır. Word’e aktarmadan önce isim, T.C., tarih ve şüpheli alanları kontrol et.')}
    catch(e){setStatus(e.message,true)}finally{b.classList.remove('busy');b.textContent=old}
  };

  async function saveText(){const v=text.value.trim();if(!v)throw new Error('Önce metne çevir veya metin gir.');await post('/api/ai/text',{text:v});renderUncertain();return v}
  q('#ai3153SaveText').onclick=()=>saveText().then(()=>setStatus('Düzeltmeler kaydedildi.')).catch(e=>setStatus(e.message,true));
  q('#ai3153AutoClear').onchange=()=>post('/api/config',{ai_auto_clear:q('#ai3153AutoClear').checked}).catch(()=>{});

  q('#ai3153OpenWord').onclick=()=>post('/api/ai/open-word').then(()=>setStatus('Microsoft Word açılıyor.')).catch(e=>setStatus(e.message,true));

  q('#ai3153Word').onclick=async()=>{
    try{const v=await saveText();setStatus('Word belgesi hazırlanıyor…');const d=await post('/api/ai/word',{text:v,name:q('#ai3153Name').value,auto_clear:q('#ai3153AutoClear').checked});setStatus(`Word açıldı: ${d.name}. Yazdırınca Belge Hazırlama + çıktı onaya gelecek.`);if(d.auto_cleared){text.value='';await refreshState()}}
    catch(e){setStatus(e.message,true)}
  };
  q('#ai3153Pdf').onclick=async()=>{
    try{const v=await saveText();setStatus('PDF hazırlanıyor…');const d=await post('/api/ai/pdf',{text:v,name:q('#ai3153Name').value,auto_clear:q('#ai3153AutoClear').checked});setStatus(`PDF hazır: ${d.name}`);try{await post('/api/documents/open-folder')}catch{}if(d.auto_cleared){text.value='';await refreshState()}}
    catch(e){setStatus(e.message,true)}
  };
  q('#ai3153Whatsapp').onclick=async()=>{
    try{const v=await saveText();await post('/api/ai/whatsapp',{text:v,auto_clear:q('#ai3153AutoClear').checked});openWhatsApp();setStatus('Metin panoya kopyalandı. İçerideki WhatsApp Web sekmesinde müşteri sohbetine yapıştır.');if(q('#ai3153AutoClear').checked){text.value='';await refreshState()}}
    catch(e){setStatus(e.message,true)}
  };
  q('#ai3153Clear').onclick=()=>post('/api/ai/clear').then(()=>{text.value='';refreshState();setStatus('AI işlem verisi temizlendi.')}).catch(e=>setStatus(e.message,true));

  window.addEventListener('focus',()=>{if(ai.classList.contains('visible'))refreshState()});
  refreshState();
})();
