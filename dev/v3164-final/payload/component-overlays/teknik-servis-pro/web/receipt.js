(()=>{
  window.TeknikServisLogoUrl='/api/logo';
  const esc=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
  const get=k=>document.querySelector(`[data-k="${k}"]`)?.value||'';
  const cell=(label,value,full=false)=>`<div class="box ${full?'full':''}"><div class="label">${label}</div><div class="value">${esc(value||'—')}</div></div>`;
  const logoUrl=()=>window.TeknikServisLogoUrl||new URL('kafepin-logo.jpg',document.baseURI).href;

  function build(){
    const savedTicket=document.querySelector('#ticket').textContent;
    const ticket=savedTicket.startsWith('Servis No:')?savedTicket:'YENİ SERVİS FİŞİ • TASLAK';
    const price=Number(get('price')||0).toLocaleString('tr-TR',{minimumFractionDigits:2,maximumFractionDigits:2});
    const payment=`${get('payment_status')||'Bekliyor'} • ${get('payment_method')||'Nakit'}`;
    document.querySelector('#receipt').innerHTML=`<div class="receipt-head"><img src="${logoUrl()}" alt="İşletme logosu"><div><h1>TEKNİK SERVİS FİŞİ</h1><div class="ticket">${esc(ticket)}</div><div class="head-note">Cihaz kabul • servis takip • teslim belgesi</div></div></div><div class="grid">${cell('Müşteri',`${get('first_name')} ${get('last_name')}`.trim()+`\n${get('phone')}`)}${cell('Cihaz',`${get('device_type')}\n${get('brand_model')}\nSeri No: ${get('serial_no')}`)}${cell('Arıza Açıklaması',get('fault'),true)}${cell('Bırakılan Aksesuarlar',get('accessories'))}${cell('Dış Görünüş / Not',get('condition_note'))}${cell('Yapılan İşlem',get('work_done'),true)}${cell('Servis Durumu',`${get('status')}\nTahmini teslim: ${get('due_date')}`)}<div class="box"><div class="label">Tahsilat</div><div class="price">${price} ₺</div><div class="value">Ödeme: <b>${esc(payment)}</b></div></div>${cell('Ek Not',get('notes'),true)}</div><div class="signatures"><div>Müşteri İmzası<br><br>______________________</div><div>Yetkili İmzası<br><br>______________________</div></div><div class="footer"><span>KafePin Teknik Servis</span><span>Bu fiş cihaz teslim ve servis takip belgesidir.</span></div>`;
    return document.querySelector('#receipt');
  }

  async function waitForPrintAssets(root){
    const images=[...root.querySelectorAll('img')];
    await Promise.all(images.map(async img=>{
      if(!(img.complete&&img.naturalWidth>0)){
        await new Promise(resolve=>{
          let done=false;
          const finish=()=>{if(done)return;done=true;resolve()};
          img.addEventListener('load',finish,{once:true});
          img.addEventListener('error',finish,{once:true});
          setTimeout(finish,4000);
        });
      }
      if(img.decode){try{await img.decode()}catch{}}
    }));
    if(document.fonts?.ready){try{await document.fonts.ready}catch{}}
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  }

  async function printReceipt(){
    const receipt=build();
    await waitForPrintAssets(receipt);
    window.focus();
    window.print();
  }

  setTimeout(()=>{
    document.querySelector('#print').onclick=printReceipt;
    const logoButton=document.querySelector('#logoSelect'),logoFile=document.querySelector('#logoFile');
    logoButton.onclick=()=>logoFile.click();
    logoFile.onchange=async e=>{
      const file=e.target.files?.[0];if(!file)return;
      if(file.size>5*1024*1024){alert('Logo en fazla 5 MB olabilir.');e.target.value='';return}
      try{
        const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});
        const response=await fetch('/api/settings/logo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data_url:dataUrl})});
        const result=await response.json();if(!result.ok)throw new Error(result.error||'Kaydedilemedi');
        window.TeknikServisLogoUrl='/api/logo?v='+Date.now();alert('Logo kaydedildi. Yeni fişlerde otomatik kullanılır.');
      }catch(err){alert('Logo kaydedilemedi: '+err.message)}finally{e.target.value=''}
    };
    document.querySelector('#refresh').onclick=()=>location.reload();
  },0);
})();
