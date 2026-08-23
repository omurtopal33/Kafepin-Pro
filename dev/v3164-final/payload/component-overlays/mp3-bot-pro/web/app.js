const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const searchKey=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/ı/g,'i').toLocaleLowerCase('tr').trim();
const mp3VersionLine=document.querySelector('.hero p');if(mp3VersionLine)mp3VersionLine.textContent='v2.34.32 PRATİK GEZGİN + SEÇİLİ PARÇA • v2.26 işlev tabanı • KafePin çekirdeğinden bağımsız web motoru';
let state=null, youtubeResults=[], selectedYoutube=new Set(), selectedSongIndex=null, youtubePreviewIndex=null, youtubePreviewCollectionIndex=null, youtubePreviewUrl='', youtubeDurationSort='none';
let artistCollections=[], collectionTracks=[], selectedCollectionTracks=new Set(), activeArtistInfo=null;
let selectedTrack=0, playingTrackIndex=null, activeCustomer='', currentTracks=[];
let shuffleEnabled=localStorage.getItem('kafepin_mp3_shuffle')==='1', shuffleQueue=[], shuffleHistory=[];
let activePlaybackSource='customer', activePlaybackTracks=[], activePlaybackIndex=null, activePlaybackQueueKey='customer';
let seekDragging=false, playerVolumeEditing=false, previewVolumeEditing=false, refreshBusy=false;
let lastVolume=85, playerVolumeSaveTimer=null, previewVolumeTimer=null, listenEqSaveTimer=null;

const webPlayer=$('#webPlayer');
let audioCtx=null, mediaSource=null, preampNode=null, highpassNode=null, eqNodes=[], compressorNode=null, masterGainNode=null;
let currentListenEq='Orijinal / Düz', listenEqInitialized=false;

const LISTEN_EQ={
  'Orijinal / Düz':{preampDb:0,highpass:10,bands:[]},
  'Normal Dengeli':{preampDb:-1.0,highpass:25,bands:[
    {f:90,q:.9,g:.7},{f:250,q:1,g:-.4},{f:3000,q:1,g:.4},{f:10000,q:.8,g:.4}
  ]},
  'Araba Dengeli':{preampDb:-2.0,highpass:30,bands:[
    {f:70,q:.9,g:1.5},{f:220,q:1,g:-.8},{f:2500,q:1,g:.8},{f:8500,q:.8,g:.7}
  ]},
  'Araba Baslı':{preampDb:-3.2,highpass:28,bands:[
    {f:60,q:.85,g:2.4},{f:120,q:.9,g:1.4},{f:260,q:1,g:-1.0},{f:2800,q:1,g:.5},{f:8500,q:.8,g:.5}
  ]},
  'Pop Canlı':{preampDb:-2.4,highpass:28,bands:[
    {f:80,q:.9,g:1.0},{f:250,q:1,g:-.7},{f:2800,q:1,g:1.1},{f:9000,q:.8,g:1.2}
  ]},
  'Rock Güçlü':{preampDb:-3.0,highpass:30,bands:[
    {f:90,q:.9,g:1.4},{f:350,q:1,g:-1.0},{f:2200,q:1,g:1.3},{f:6500,q:.9,g:.9}
  ]},
  'Vokal Net':{preampDb:-2.2,highpass:35,bands:[
    {f:120,q:.9,g:-.4},{f:350,q:1,g:-.7},{f:2500,q:1,g:1.6},{f:5000,q:.9,g:.8},{f:10000,q:.8,g:.4}
  ]},
  'Kulaklık Dengeli':{preampDb:-2.0,highpass:20,bands:[
    {f:70,q:.9,g:.8},{f:200,q:1,g:-.4},{f:3000,q:1,g:.6},{f:8000,q:.8,g:.6}
  ]},
  'Gece Yumuşak':{preampDb:-1.8,highpass:25,bands:[
    {f:100,q:.9,g:.6},{f:400,q:1,g:-.5},{f:3000,q:1,g:-.4},{f:9000,q:.8,g:-1.0}
  ]},
  'Derin Bas':{preampDb:-4.2,highpass:26,bands:[
    {f:55,q:.8,g:3.0},{f:110,q:.9,g:1.6},{f:250,q:1,g:-1.2},{f:2500,q:1,g:.4},{f:8500,q:.8,g:.3}
  ]}
};

async function api(url, options={}){
  const opts={cache:'no-store',...options};
  opts.headers={'Content-Type':'application/json','Cache-Control':'no-cache',...(options.headers||{})};
  const r=await fetch(url,opts);
  const data=await r.json().catch(()=>({ok:false,error:`HTTP ${r.status}`}));
  if(!r.ok||data.ok===false) throw new Error(data.error||`HTTP ${r.status}`);
  return data;
}
function post(url,data={}){return api(url,{method:'POST',body:JSON.stringify(data)})}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(sec){sec=Math.max(0,Number(sec)||0);const m=Math.floor(sec/60),s=Math.floor(sec%60);return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function durationFmt(sec){if(sec==null)return'';return fmt(sec)}
function toast(msg,bad=false){const e=$('#statusBar');if(!e)return;e.textContent=msg;e.style.color=bad?'#ff9aa5':'#b7d9ea'}
function showError(e){toast(e?.message||String(e),true)}
async function safeAction(btn,fn){if(btn?.classList.contains('busy'))return;try{btn?.classList.add('busy');await fn()}catch(e){showError(e)}finally{btn?.classList.remove('busy')}}
async function hardRefresh(){await refreshState();if($('#listenModeBtn').classList.contains('active'))await refreshCustomers(false);toast('✓ Panel yenilendi — çalma kesintisiz devam ediyor')}
window.kafePinSoftRefresh=hardRefresh;
window.kafePinPrepareReload=()=>{try{const activeMode=$('#listenMode')?.classList.contains('visible')?'listen':$('#winampMode')?.classList.contains('visible')?'winamp':$('#favoritesMode')?.classList.contains('visible')?'favorites':'download';sessionStorage.setItem('kafepin_mp3_reload_state',JSON.stringify({src:webPlayer.currentSrc||webPlayer.src||'',time:Number(webPlayer.currentTime)||0,wasPlaying:!webPlayer.paused,volume:Number(webPlayer.volume),title:$('#nowPlaying')?.textContent||'',mode:activeMode,customer:activeCustomer,winampTracks:window.winampTracks||[],winampActiveIndex:window.winampActiveIndex,playbackSource:activePlaybackSource,playbackTracks:activePlaybackTracks,playbackIndex:activePlaybackIndex,playbackQueueKey:activePlaybackQueueKey}));return true}catch{return false}};
async function restoreAfterPanelReload(){let saved;try{saved=JSON.parse(sessionStorage.getItem('kafepin_mp3_reload_state')||'null');sessionStorage.removeItem('kafepin_mp3_reload_state')}catch{return}if(!saved)return;try{if(saved.mode==='winamp'){window.winampTracks=Array.isArray(saved.winampTracks)?saved.winampTracks:[];window.winampActiveIndex=Number.isInteger(saved.winampActiveIndex)?saved.winampActiveIndex:-1;openWinampPlayback()}else if(saved.mode==='favorites')$('#favoritesModeBtn')?.click();else if(saved.mode==='listen'){setMode('listen');setSharedCustomerPlaylistVisible(true);if(saved.customer)activeCustomer=saved.customer;await refreshCustomers(true)}activePlaybackSource=['winamp','favorites'].includes(saved.playbackSource)?saved.playbackSource:'customer';activePlaybackTracks=Array.isArray(saved.playbackTracks)?saved.playbackTracks:[];activePlaybackIndex=Number.isInteger(saved.playbackIndex)?saved.playbackIndex:null;activePlaybackQueueKey=String(saved.playbackQueueKey||activePlaybackSource);if(!saved.src)return;webPlayer.src=saved.src;webPlayer.load();await new Promise(resolve=>{const done=()=>resolve();webPlayer.addEventListener('loadedmetadata',done,{once:true});setTimeout(done,2500)});if(Number.isFinite(saved.time)&&saved.time>0)webPlayer.currentTime=saved.time;if(Number.isFinite(saved.volume))webPlayer.volume=saved.volume;if(saved.wasPlaying){await ensureAudioReady();if(audioCtx?.state==='suspended')await audioCtx.resume();await webPlayer.play()}if(saved.title)$('#nowPlaying').textContent=saved.title}catch{}}
function setSharedCustomerPlaylistVisible(visible){const card=$('#trackRows')?.closest('.customer-playlist-card');if(card)card.style.display=visible?'':'none'}
function openWinampPlayback(){const winamp=$('#winampMode'),player=$('.player-card');if(!winamp)return;$('#downloadMode').classList.remove('visible');$('#listenMode').classList.remove('visible');$('#favoritesMode').classList.remove('visible');winamp.classList.add('visible');$$('.tab').forEach(tab=>tab.classList.remove('active'));$('#winampModeBtn').classList.add('active');setSharedCustomerPlaylistVisible(false);window.renderWinampTracks?.(Number.isInteger(window.winampActiveIndex)?window.winampActiveIndex:-1);if(player){winamp.insertBefore(player,winamp.firstChild);player.style.display='block'}}
function setMode(mode){$('#downloadMode').classList.toggle('visible',mode==='download');$('#listenMode').classList.toggle('visible',mode==='listen');$('#downloadModeBtn').classList.toggle('active',mode==='download');$('#listenModeBtn').classList.toggle('active',mode==='listen');if(mode==='listen')refreshCustomers(false)}

function dbToGain(db){return Math.pow(10,Number(db)/20)}
function smoothParam(param,value,time=.025){
  if(!audioCtx)return;
  const now=audioCtx.currentTime;
  try{param.cancelScheduledValues(now);param.setTargetAtTime(Number(value),now,time)}catch{try{param.value=Number(value)}catch{}}
}
function createListenAudioGraph(){
  if(audioCtx)return;
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw new Error('Bu WebView ses EQ motorunu desteklemiyor. WebView2 güncel olmalı.');
  audioCtx=new AC();
  mediaSource=audioCtx.createMediaElementSource(webPlayer);
  preampNode=audioCtx.createGain();
  highpassNode=audioCtx.createBiquadFilter();highpassNode.type='highpass';highpassNode.Q.value=.707;
  eqNodes=Array.from({length:5},()=>{const n=audioCtx.createBiquadFilter();n.type='peaking';n.frequency.value=1000;n.Q.value=1;n.gain.value=0;return n});
  compressorNode=audioCtx.createDynamicsCompressor();
  compressorNode.threshold.value=-2.0;compressorNode.knee.value=0;compressorNode.ratio.value=20;compressorNode.attack.value=.003;compressorNode.release.value=.16;
  masterGainNode=audioCtx.createGain();
  mediaSource.connect(preampNode);preampNode.connect(highpassNode);
  let last=highpassNode;eqNodes.forEach(n=>{last.connect(n);last=n});
  last.connect(compressorNode);compressorNode.connect(masterGainNode);masterGainNode.connect(audioCtx.destination);
  webPlayer.volume=1;
  applyListeningEqValue(currentListenEq,false);
  setBrowserVolume(lastVolume,false);
}
async function ensureAudioReady(){createListenAudioGraph();if(audioCtx.state==='suspended')await audioCtx.resume()}
function applyListeningEqValue(name,save=true){
  if(!LISTEN_EQ[name])name='Orijinal / Düz';
  currentListenEq=name;
  if($('#listenEqPreset')&&$('#listenEqPreset').value!==name)$('#listenEqPreset').value=name;
  if(audioCtx){
    const p=LISTEN_EQ[name];
    smoothParam(preampNode.gain,dbToGain(p.preampDb),.035);
    smoothParam(highpassNode.frequency,p.highpass||10,.035);
    eqNodes.forEach((node,i)=>{const b=p.bands[i];if(b){smoothParam(node.frequency,b.f,.035);smoothParam(node.Q,b.q,.035);smoothParam(node.gain,b.g,.035)}else{smoothParam(node.gain,0,.035)}});
  }
  const status=$('#listenEqStatus');if(status)status.textContent=`${name} • canlı • kesintisiz`;
  if(save){
    if(listenEqSaveTimer)clearTimeout(listenEqSaveTimer);
    listenEqSaveTimer=setTimeout(()=>post('/api/config',{listen_eq_preset:name}).catch(showError),180);
  }
}
function populateEqSelect(select,items){if(!select)return;if(!select.options.length)(items||Object.keys(LISTEN_EQ)).forEach(v=>select.add(new Option(v,v)))}

async function refreshState(){
  if(refreshBusy)return;refreshBusy=true;
  try{
    const d=await api('/api/state?_='+Date.now());state=d;toast(d.status||'Hazır');renderConfig(d.config);renderRows(d.rows||[]);renderPreview(d.preview||{});renderPhone(d.phone||{});const downloadBtn=$('#downloadBtn');if(downloadBtn){downloadBtn.disabled=!!d.download_running;downloadBtn.textContent=d.download_running?'İNDİRİLİYOR — TEK KUYRUK':'▼ İNDİR ▼'}
    $('#healthBadge').textContent=`MP3 servis hazır • ${d.version}`;$('#healthBadge').className='health ok';
  }catch(e){$('#healthBadge').textContent='MP3 servis hatası';$('#healthBadge').className='health bad';showError(e)}finally{refreshBusy=false}
}
function renderConfig(c){if(!c)return;
  if(document.activeElement!==$('#customerRoot'))$('#customerRoot').value=c.customer_root||'';
  if($('#favoriteRoot'))$('#favoriteRoot').value=c.favorites_root||'';
  $('#bitrate').value=String(c.direct_bitrate_kbps||320);
  populateEqSelect($('#eqPreset'),c.eq_presets||[]);$('#eqPreset').value=c.eq_preset||'Araba Dengeli';
  populateEqSelect($('#listenEqPreset'),c.listen_eq_presets||Object.keys(LISTEN_EQ));
  if(!listenEqInitialized){applyListeningEqValue(c.listen_eq_preset||'Orijinal / Düz',false);listenEqInitialized=true;}
  if(!playerVolumeEditing&&!previewVolumeEditing)showVolume(Number(c.player_volume??85),false);
  updateTargetPreview();
}
function configPayload(){return {customer_root:$('#customerRoot').value.trim(),favorites_root:$('#favoriteRoot')?.value.trim()||'',direct_bitrate_kbps:Number($('#bitrate').value),eq_preset:$('#eqPreset').value,listen_eq_preset:currentListenEq,player_volume:Number($('#playerVolume').value)}}
async function saveConfig(){const d=await post('/api/config',configPayload());if(d.config)renderConfig(d.config);updateTargetPreview();return d}
function updateTargetPreview(){const r=$('#customerRoot').value.trim(),c=$('#customerName').value.trim();$('#targetPreview').textContent=`Müşteri klasörü: ${r&&c?r.replace(/[\\/]+$/,'')+'\\'+c:'-'}`}
function renderRows(rows){const tb=$('#songRows');tb.innerHTML='';if(selectedSongIndex!=null&&selectedSongIndex>=rows.length)selectedSongIndex=rows.length?rows.length-1:null;rows.forEach((r,i)=>{const tr=document.createElement('tr');tr.dataset.index=i;tr.innerHTML=`<td>${i+1}</td><td><b>${esc(r.query)}</b></td><td>${esc(r.title||'')}<div class="mono">${esc(r.url||'')}</div></td><td>${esc(r.status||'')}</td><td><button class="delete-row" data-del="${i}">Sil</button></td>`;tr.addEventListener('click',e=>{if(e.target.dataset.del!=null)return;selectedSongIndex=i;$$('#songRows tr').forEach(x=>x.classList.remove('selected'));tr.classList.add('selected')});if(i===selectedSongIndex)tr.classList.add('selected');tb.appendChild(tr)});$('#rowCount').textContent=`${rows.length} şarkı`;$$('[data-del]').forEach(b=>b.onclick=()=>safeAction(b,()=>deleteRow(Number(b.dataset.del))))}
async function deleteRow(i){await post('/api/list/delete',{indices:[i]});if(selectedSongIndex===i)selectedSongIndex=null;else if(selectedSongIndex!=null&&selectedSongIndex>i)selectedSongIndex--;await refreshState()}

async function runYoutubeSearch(){const q=$('#youtubeQuery').value.trim();if(!q)throw new Error('YouTube araması için sanatçı veya şarkı yaz.');await stopYoutubePreview(true);toast(`YouTube aranıyor: ${q} ...`);const d=await post('/api/youtube/search',{query:q,max_results:40});youtubeResults=d.results||[];youtubeDurationSort='none';$('#youtubeDurationSortBtn').textContent='Süre ↕';selectedYoutube.clear();artistCollections=[];collectionTracks=[];selectedCollectionTracks.clear();$('#artistListsPanel').classList.add('hidden-row');renderYoutube();toast(`${youtubeResults.length} YouTube sonucu bulundu`)}
function sortYoutubeByDuration(){const selectedRows=new Set([...selectedYoutube].map(i=>youtubeResults[i]).filter(Boolean));const playingRow=youtubePreviewIndex==null?null:youtubeResults[youtubePreviewIndex];youtubeDurationSort=youtubeDurationSort==='asc'?'desc':'asc';const direction=youtubeDurationSort==='asc'?1:-1;youtubeResults.sort((a,b)=>{const da=Number(a.duration),db=Number(b.duration),aValid=Number.isFinite(da)&&da>=0,bValid=Number.isFinite(db)&&db>=0;if(!aValid||!bValid)return aValid===bValid?0:(aValid?-1:1);return direction*(da-db)});selectedYoutube=new Set(youtubeResults.map((row,i)=>selectedRows.has(row)?i:null).filter(i=>i!==null));youtubePreviewIndex=playingRow?youtubeResults.indexOf(playingRow):null;$('#youtubeDurationSortBtn').textContent=youtubeDurationSort==='asc'?'Süre ↑':'Süre ↓';renderYoutube();toast(youtubeDurationSort==='asc'?'Süre: kısa → uzun sıralandı.':'Süre: uzun → kısa sıralandı.')}
function renderYoutube(){const tb=$('#youtubeRows');tb.innerHTML='';youtubeResults.forEach((r,i)=>{const tr=document.createElement('tr');tr.dataset.i=i;const free=(r.match_reason||'').toLowerCase().includes('serbest arama');const match=free?'YOUTUBE':(r.strict_match===false?'⚠ DİĞER SONUÇ':`✓ TAM ${esc(r.match_score??r.score)}`);const hasArtist=!!((r.artist||r.channel||'').trim());const listening=youtubePreviewIndex===i;const listenUrl=encodeURIComponent(String(r.url||''));tr.innerHTML=`<td>${r.youtube_rank||i+1}</td><td><b>${esc(r.title)}</b>${r.artist&&r.track_title?`<small class="result-meta">${esc(r.artist)} • ${esc(r.track_title)}</small>`:''}</td><td>${esc(r.channel)}</td><td>${durationFmt(r.duration)}</td><td>${match}</td><td><button class="mini-btn youtube-listen-row${listening?' active':''}" data-youtube-listen="${i}" data-youtube-url="${listenUrl}">${listening?'■ DURDUR':'▶ DİNLE'}</button></td><td>${hasArtist?`<button class="mini-btn artist-playlists-row" data-artist-list="${i}">🎵 PLAYLISTLER</button>`:'-'}</td>`;tr.onclick=e=>{if(e.target.closest('[data-artist-list],[data-youtube-listen]'))return;if(e.ctrlKey||e.shiftKey){selectedYoutube.has(i)?selectedYoutube.delete(i):selectedYoutube.add(i)}else{selectedYoutube.clear();selectedYoutube.add(i)}renderYoutube()};tr.ondblclick=e=>{if(e.target.closest('[data-artist-list],[data-youtube-listen]'))return;safeAction(tr,async()=>{await post('/api/list/add',{items:[r]});toast(`✓ Listeye eklendi: ${r.artist||''}${r.artist?' - ':''}${r.track_title||r.title}`);await refreshState()})};if(selectedYoutube.has(i))tr.classList.add('selected');tb.appendChild(tr)});$$('[data-youtube-listen]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const rowIndex=Number(b.dataset.youtubeListen);const sourceUrl=decodeURIComponent(String(b.dataset.youtubeUrl||''));safeAction(b,()=>toggleYoutubePreview(rowIndex,sourceUrl))});$$('[data-artist-list]').forEach(b=>b.onclick=e=>{e.stopPropagation();const i=Number(b.dataset.artistList);selectedYoutube.clear();selectedYoutube.add(i);renderYoutube();safeAction(b,()=>loadArtistLists(youtubeResults[i]))})}
function youtubeInstantStreamUrl(url){return `/api/youtube/instant-stream?url=${encodeURIComponent(url)}&_=${Date.now()}`}
function stopYoutubePreviewNow(silent=true){
  const had=youtubePreviewIndex!=null||youtubePreviewCollectionIndex!=null||!!youtubePreviewUrl;
  if(!had)return;
  youtubePreviewIndex=null;
  youtubePreviewCollectionIndex=null;
  youtubePreviewUrl='';
  try{webPlayer.pause();webPlayer.currentTime=0;webPlayer.removeAttribute('src');webPlayer.load()}catch{}
  playingTrackIndex=null;
  try{markSelectedTrack();renderBrowserPlayer();$('#nowPlaying').textContent='■ Durduruldu'}catch{}
  if(youtubeResults.length)renderYoutube();
  if(collectionTracks.length)renderCollectionTracks();
  if(had&&!silent)toast('■ YouTube dinleme durduruldu.');
}
function stopMainListenNow(){
  try{webPlayer.pause()}catch{}
  try{webPlayer.currentTime=0}catch{}
  try{webPlayer.removeAttribute('src');webPlayer.load()}catch{}
  playingTrackIndex=null;
  try{markSelectedTrack();renderBrowserPlayer();$('#nowPlaying').textContent='■ Durduruldu'}catch{}
}
function toggleYoutubePreview(i,sourceUrl){
  const r=youtubeResults[i];
  if(!r||!sourceUrl)throw new Error('Bu YouTube sonucunda dinlenecek bağlantı yok.');
  if(youtubePreviewIndex===i&&youtubePreviewUrl===sourceUrl&&!webPlayer.paused){stopYoutubePreviewNow(false);return Promise.resolve()}

  // Butonun kendi data-youtube-url değeri kullanılır; seçili satır/state burada otorite değildir.
  // Mevcut Web Audio grafiğine bağlı webPlayer kullanılır. resume() ve play() user gesture içinde başlar.
  stopYoutubePreviewNow(true);
  stopMainListenNow();
  createListenAudioGraph();
  if(audioCtx?.state==='suspended')audioCtx.resume().catch(()=>{});
  youtubePreviewIndex=i;
  youtubePreviewCollectionIndex=null;
  youtubePreviewUrl=sourceUrl;
  webPlayer.volume=1;
  setBrowserVolume(Number($('#previewVolume').value||lastVolume),false);
  webPlayer.src=youtubeInstantStreamUrl(sourceUrl);
  webPlayer.load();
  toast(`▶ Bağlanıyor: ${r.artist||r.channel||''}${(r.artist||r.channel)?' - ':''}${r.track_title||r.title}`);
  const playPromise=webPlayer.play();
  renderYoutube();
  return Promise.resolve(playPromise).catch(e=>{
    if(youtubePreviewIndex===i&&youtubePreviewUrl===sourceUrl){stopYoutubePreviewNow(true)}
    throw new Error('YouTube anlık dinleme başlatılamadı: '+(e?.message||e));
  });
}
async function stopYoutubePreview(silent=true){stopYoutubePreviewNow(silent)}
async function addSelectedYoutube(){const items=[...selectedYoutube].sort((a,b)=>a-b).map(i=>youtubeResults[i]).filter(Boolean);if(!items.length)throw new Error('Önce YouTube sonuçlarından seçim yap.');const d=await post('/api/list/add',{items});toast(`${d.added} şarkı eklendi${d.duplicate?` • ${d.duplicate} tekrar engellendi`:''}`);await refreshState()}
function selectedYoutubeResult(){const ids=[...selectedYoutube].sort((a,b)=>a-b);return ids.length?youtubeResults[ids[0]]:null}
async function loadArtistLists(resultOverride=null){
  const r=resultOverride||selectedYoutubeResult();if(!r)throw new Error('Önce sanatçısını görmek istediğin YouTube sonucunu seç.');
  const artist=(r.artist||r.channel||'').trim();if(!artist&&!r.artist_id)throw new Error('Bu sonuçta sanatçı bilgisi bulunamadı.');
  toast(`YouTube sanatçı kanalı ve oynatma listeleri açılıyor: ${artist||'sanatçı'} ...`);
  const d=await post('/api/youtube/artist-lists',{artist,artist_id:r.artist_id||'',channel:r.channel||'',channel_id:r.channel_id||'',channel_url:r.channel_url||''});
  activeArtistInfo={artist:d.artist||artist,artist_id:d.artist_id||r.artist_id||''};artistCollections=d.collections||[];collectionTracks=[];selectedCollectionTracks.clear();
  $('#artistListsPanel').classList.remove('hidden-row');$('#collectionTracksPanel').classList.add('hidden-row');
  $('#artistListsTitle').textContent=`🎤 ${activeArtistInfo.artist} • YouTube Kanalı / Oynatma Listeleri`;
  const channelPlaylistCount=artistCollections.filter(c=>c.kind==='channel_playlist').length;
  const playlistCount=artistCollections.filter(c=>['channel_playlist','official_playlist','playlist'].includes(c.kind)).length;
  const releaseCount=artistCollections.length-playlistCount;
  $('#artistListsCount').textContent=`${channelPlaylistCount} kanal playlisti • ${playlistCount} toplam playlist • ${releaseCount} albüm/şarkı`;renderArtistCollections();
  toast(channelPlaylistCount?`${activeArtistInfo.artist}: YouTube kanalında ${channelPlaylistCount} oynatma listesi bulundu`:`${activeArtistInfo.artist}: kanal playlisti yok; diğer sanatçı listeleri gösteriliyor`);
}
function kindLabel(k){return ({songs:'ŞARKILAR',channel_playlist:'YOUTUBE KANAL PLAYLIST',official_playlist:'RESMİ PLAYLIST',album:'ALBÜM',single:'SINGLE',playlist:'PLAYLIST'})[k]||String(k||'LISTE').toUpperCase()}
function renderArtistCollections(){const box=$('#artistCollections');box.innerHTML='';artistCollections.forEach((c,i)=>{const b=document.createElement('button');b.className='artist-collection';b.innerHTML=`<span class="collection-kind">${esc(kindLabel(c.kind))}</span><b>${esc(c.title)}</b><small>${esc([c.source,c.subtitle].filter(Boolean).join(' • '))}</small>`;b.onclick=()=>safeAction(b,()=>loadArtistCollection(i));box.appendChild(b)});if(!artistCollections.length)box.innerHTML='<div class="note">Bu sanatçı için doğrulanmış şarkı/albüm/oynatma listesi bulunamadı.</div>'}
async function loadArtistCollection(i){const c=artistCollections[i];if(!c)return;toast(`Liste açılıyor: ${c.title} ...`);const d=await post('/api/youtube/collection-tracks',{id:c.id,kind:c.kind,artist:activeArtistInfo?.artist||''});collectionTracks=d.tracks||[];selectedCollectionTracks.clear();$('#collectionTracksPanel').classList.remove('hidden-row');$('#collectionTitle').textContent=`♫ ${c.title}`;$('#collectionCount').textContent=`${collectionTracks.length} şarkı`;renderCollectionTracks();toast(`${c.title}: ${collectionTracks.length} şarkı`)}
function renderCollectionTracks(){const tb=$('#collectionTrackRows');tb.innerHTML='';collectionTracks.forEach((r,i)=>{const tr=document.createElement('tr');tr.dataset.i=i;const listening=youtubePreviewCollectionIndex===i;const listenUrl=encodeURIComponent(String(r.url||''));tr.innerHTML=`<td>${i+1}</td><td><b>${esc(r.title)}</b></td><td>${esc(r.artist||r.channel||'')}</td><td>${durationFmt(r.duration)}</td><td><button class="mini-btn youtube-listen-row${listening?' active':''}" data-collection-listen="${i}" data-youtube-url="${listenUrl}">${listening?'■ DURDUR':'▶ DİNLE'}</button></td>`;tr.onclick=e=>{if(e.target.closest('[data-collection-listen]'))return;if(e.ctrlKey||e.shiftKey){selectedCollectionTracks.has(i)?selectedCollectionTracks.delete(i):selectedCollectionTracks.add(i)}else{selectedCollectionTracks.clear();selectedCollectionTracks.add(i)}renderCollectionTracks()};tr.ondblclick=e=>{if(e.target.closest('[data-collection-listen]'))return;safeAction(tr,async()=>{await post('/api/list/add',{items:[r]});toast(`✓ Listeye eklendi: ${r.artist||r.channel||''} - ${r.title}`);await refreshState()})};if(selectedCollectionTracks.has(i))tr.classList.add('selected');tb.appendChild(tr)});$$('[data-collection-listen]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const rowIndex=Number(b.dataset.collectionListen);const sourceUrl=decodeURIComponent(String(b.dataset.youtubeUrl||''));safeAction(b,()=>toggleCollectionPreview(rowIndex,sourceUrl))})}
function toggleCollectionPreview(i,sourceUrl){const r=collectionTracks[i];if(!r||!sourceUrl)throw new Error('Bu playlist sonucunda dinlenecek bağlantı yok.');if(youtubePreviewCollectionIndex===i&&youtubePreviewUrl===sourceUrl&&!webPlayer.paused){stopYoutubePreviewNow(false);return Promise.resolve()}stopYoutubePreviewNow(true);stopMainListenNow();createListenAudioGraph();if(audioCtx?.state==='suspended')audioCtx.resume().catch(()=>{});youtubePreviewIndex=null;youtubePreviewCollectionIndex=i;youtubePreviewUrl=sourceUrl;webPlayer.volume=1;setBrowserVolume(Number($('#previewVolume').value||lastVolume),false);webPlayer.src=youtubeInstantStreamUrl(sourceUrl);webPlayer.load();toast(`▶ Bağlanıyor: ${r.artist||r.channel||''}${(r.artist||r.channel)?' - ':''}${r.track_title||r.title}`);const playPromise=webPlayer.play();renderCollectionTracks();return Promise.resolve(playPromise).catch(e=>{if(youtubePreviewCollectionIndex===i&&youtubePreviewUrl===sourceUrl){stopYoutubePreviewNow(true)}throw new Error('Playlist anlık dinleme başlatılamadı: '+(e?.message||e))})}
function selectAllCollection(){if(selectedCollectionTracks.size===collectionTracks.length)selectedCollectionTracks.clear();else collectionTracks.forEach((_,i)=>selectedCollectionTracks.add(i));renderCollectionTracks()}
async function addSelectedCollectionTracks(){const items=[...selectedCollectionTracks].sort((a,b)=>a-b).map(i=>collectionTracks[i]).filter(Boolean);if(!items.length)throw new Error('Önce sanatçı listesinden şarkı seç.');const d=await post('/api/list/add',{items});toast(`${d.added} şarkı ana listeye eklendi${d.duplicate?` • ${d.duplicate} tekrar engellendi`:''}`);await refreshState()}
async function loadText(){await post('/api/list/set-text',{text:$('#rawText').value});await refreshState()}
async function startResolve(){await post('/api/list/resolve');toast('YouTube bağlantıları hazırlanıyor...')}
function selectedSong(){if(selectedSongIndex==null||!state)return null;return state.rows[selectedSongIndex]||null}
async function switchEq(){await saveConfig()}
function renderPreview(p){/* YouTube DİNLE artık dosya hazırlayan eski EQ preview motorunu kullanmaz. */}
async function startDownload(){if(state?.download_running)throw new Error('İndirme zaten tek kuyrukta sürüyor.');if(!state?.rows?.length)throw new Error('Önce şarkı ekle veya YouTube’dan seçim yap.');const customer=$('#customerName').value.trim();if(!customer)throw new Error('Müşteri adı yaz.');const msg=`${state.rows.length} şarkı • Tekli sıra • KafePin MP3 Motoru • ${$('#bitrate').value} kbps • EQ ${$('#eqPreset').value}\n\nŞarkılar birbiri bitmeden sıradakine geçmeyecek. İndirme başlatılsın mı?`;if(!confirm(msg))return;await saveConfig();await post('/api/download',{customer,customer_root:$('#customerRoot').value.trim(),bitrate:Number($('#bitrate').value),eq_preset:$('#eqPreset').value});toast('Tekli indirme kuyruğu başladı…')}

async function refreshCustomers(preserve=true){await saveConfig();const d=await api('/api/customers?_='+Date.now());const customers=d.customers||[], box=$('#customerList');box.innerHTML='';customers.forEach(c=>{const e=document.createElement('div');e.className='customer-item'+(c===activeCustomer?' active':'');e.textContent=c;e.onclick=()=>safeAction(e,()=>selectCustomer(c));box.appendChild(e)});if((!preserve||!activeCustomer||!customers.includes(activeCustomer))&&customers.length)activeCustomer=customers[0];if(activeCustomer&&customers.includes(activeCustomer))await selectCustomer(activeCustomer);else renderTracks([])}
async function selectCustomer(c){activeCustomer=c;$$('.customer-item').forEach(e=>e.classList.toggle('active',e.textContent===c));const d=await api(`/api/tracks?customer=${encodeURIComponent(c)}&_=${Date.now()}`);renderTracks(d.tracks||[])}
async function refreshTracks(){if(!activeCustomer)return refreshCustomers(false);await selectCustomer(activeCustomer);toast('Şarkı listesi yenilendi.')}
let customerLibraryPollBusy=false;
async function refreshVisibleCustomerLibrary(){if(customerLibraryPollBusy||!$('#listenMode')?.classList.contains('visible'))return;customerLibraryPollBusy=true;try{const customers=(await api('/api/customers?_='+Date.now())).customers||[];const shown=$$('#customerList .customer-item').map(item=>item.textContent);if(customers.join('\u0000')!==shown.join('\u0000')){await refreshCustomers(true);return}if(!activeCustomer||!customers.includes(activeCustomer))return;const d=await api(`/api/tracks?customer=${encodeURIComponent(activeCustomer)}&_=${Date.now()}`),next=d.tracks||[],before=currentTracks.map(track=>`${track.name}\u0000${track.size_mb}`).join('\u0001'),after=next.map(track=>`${track.name}\u0000${track.size_mb}`).join('\u0001');if(before!==after)renderTracks(next)}catch{}finally{customerLibraryPollBusy=false}}
async function deleteSelectedTrack(){
  if(!activeCustomer)throw new Error('Önce müşteri seç.');
  if(!currentTracks.length||!Number.isInteger(selectedTrack)||selectedTrack<0||selectedTrack>=currentTracks.length)throw new Error('Silinecek şarkıyı listeden seç.');
  const track=currentTracks[selectedTrack];
  if(!confirm(`Bu MP3 müşteri klasöründen kalıcı olarak silinsin mi?\n\n${track.name}`))return;
  const deleting=selectedTrack;
  if(playingTrackIndex===deleting){await stopBrowserAudio(true);await new Promise(r=>setTimeout(r,120));}
  const d=await post('/api/tracks/delete',{customer:activeCustomer,index:deleting});
  currentTracks=d.tracks||[];
  selectedTrack=currentTracks.length?Math.min(deleting,currentTracks.length-1):0;
  if(Number.isInteger(playingTrackIndex)){if(playingTrackIndex>deleting)playingTrackIndex--;else if(playingTrackIndex===deleting)playingTrackIndex=null;}
  renderTracks(currentTracks);
  toast(`🗑 Silindi: ${d.deleted||track.name}`);
}
async function deleteCustomerMusicFolder(customer){
  customer=String(customer||'').trim();
  if(!customer)throw new Error('Silinecek müşteriyi seç veya müşteri adını yaz.');
  const count=customer===activeCustomer?currentTracks.length:0;
  const detail=count?`\n\n${count} şarkı kalıcı olarak silinecek.`:'';
  if(!confirm(`“${customer}” müşteri klasörü ve içindeki tüm dosyalar kalıcı olarak silinsin mi?${detail}\n\nFavori klasörüne kopyalanan şarkılar korunur.`))return;
  if(customer===activeCustomer){await stopBrowserAudio(true);await post('/api/player/stop').catch(()=>{});}
  const d=await post('/api/customer/delete-folder',{customer});
  if(customer===activeCustomer){activeCustomer='';currentTracks=[];selectedTrack=0;playingTrackIndex=null;renderTracks([]);}
  await refreshCustomers(false);
  toast(`🗑 Müşteri klasörü silindi: ${d.deleted||customer}`);
}
async function chooseFavoriteFolder(){const d=await post('/api/favorites/choose-folder');if(d.config)renderConfig(d.config);toast(`⭐ Favori klasörü seçildi: ${d.folder||''}`)}
async function chooseCustomerRoot(){const d=await post('/api/customer/choose-root');if(d.config)renderConfig(d.config);updateTargetPreview();await refreshCustomers(false);toast(`📁 Müşteri müzik yeri seçildi: ${d.folder||''}`)}
async function openFavoriteFolder(){await post('/api/favorites/open-folder');toast('📁 Favori Listem klasörü açıldı.')}
function shuffleArray(items){
  const a=[...items];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
function playbackTracks(){return activePlaybackSource==='customer'?currentTracks:activePlaybackTracks}
function playbackIndex(){return activePlaybackSource==='customer'?playingTrackIndex:activePlaybackIndex}
function playbackTrack(){const tracks=playbackTracks(),index=playbackIndex();return Number.isInteger(index)?tracks[index]:null}
function queueKey(source,tracks){return `${source}\u0000${(tracks||[]).map(t=>t.token||t.name||'').join('\u0001')}`}
function activatePlaybackQueue(source,tracks,index){
  const list=source==='customer'?currentTracks:Array.isArray(tracks)?tracks.slice():[];
  const key=queueKey(source,list),changed=key!==activePlaybackQueueKey;
  activePlaybackSource=source;activePlaybackTracks=source==='customer'?[]:list;activePlaybackIndex=source==='customer'?null:index;activePlaybackQueueKey=key;
  if(source!=='customer'){window.winampActiveIndex=index;window.winampActiveToken=list[index]?.token||''}
  if(shuffleEnabled&&changed){shuffleHistory=[];rebuildShuffleQueue(index)}
}
function rebuildShuffleQueue(excludeIndex=null){
  shuffleQueue=shuffleArray(playbackTracks().map((_,i)=>i).filter(i=>i!==excludeIndex));
}
function syncShuffleAfterTrackListChange(){
  if(activePlaybackSource!=='customer')return;
  if(!shuffleEnabled){shuffleQueue=[];shuffleHistory=[];return}
  const current=Number.isInteger(playingTrackIndex)&&playingTrackIndex>=0&&playingTrackIndex<currentTracks.length?playingTrackIndex:null;
  shuffleHistory=current==null?[]:[current];
  rebuildShuffleQueue(current);
}
function recordShufflePlay(index){
  if(!shuffleEnabled)return;
  const length=playbackTracks().length;
  shuffleQueue=shuffleQueue.filter(i=>i!==index&&i>=0&&i<length);
  if(shuffleHistory[shuffleHistory.length-1]!==index)shuffleHistory.push(index);
  if(shuffleHistory.length>100)shuffleHistory=shuffleHistory.slice(-100);
}
function nextShuffleIndex(){
  const tracks=playbackTracks();if(!tracks.length)return null;
  const active=playbackIndex(),current=Number.isInteger(active)?active:(activePlaybackSource==='customer'?selectedTrack:0);
  if(tracks.length===1)return 0;
  shuffleQueue=shuffleQueue.filter(i=>i>=0&&i<tracks.length&&i!==current);
  if(!shuffleQueue.length)rebuildShuffleQueue(current);
  return shuffleQueue.shift();
}
function updateShuffleButton(){
  const b=$('#shuffleBtn');if(!b)return;
  b.textContent=shuffleEnabled?'🔀 KARIŞIK: AÇIK':'🔀 KARIŞIK: KAPALI';
  b.classList.toggle('accent',shuffleEnabled);
  b.setAttribute('aria-pressed',shuffleEnabled?'true':'false');
}
function toggleShuffle(){
  shuffleEnabled=!shuffleEnabled;
  localStorage.setItem('kafepin_mp3_shuffle',shuffleEnabled?'1':'0');
  if(shuffleEnabled){
    const current=playbackIndex();
    shuffleHistory=current==null?[]:[current];
    rebuildShuffleQueue(current);
    toast('🔀 Karışık çalma açık — şarkılar rastgele sırada çalacak.');
  }else{
    shuffleQueue=[];shuffleHistory=[];
    toast('Karışık çalma kapalı — normal sıraya dönüldü.');
  }
  updateShuffleButton();
}
function renderTracks(tracks){currentTracks=tracks;const tb=$('#trackRows');tb.innerHTML='';if(selectedTrack>=tracks.length)selectedTrack=tracks.length?tracks.length-1:0;tracks.forEach((t,i)=>{const tr=document.createElement('tr');tr.dataset.i=i;tr.innerHTML=`<td>${i+1}</td><td><b>${esc(t.name)}</b></td><td>${esc(t.size_mb)}</td>`;tr.onclick=()=>{selectedTrack=i;markSelectedTrack()};tr.ondblclick=()=>safeAction(tr,()=>playSelected());tb.appendChild(tr)});markSelectedTrack();$('#trackCount').textContent=`${tracks.length} MP3`;syncShuffleAfterTrackListChange()}
function markSelectedTrack(){$$('#trackRows tr').forEach(x=>{const i=Number(x.dataset.i);x.classList.toggle('selected',i===selectedTrack);x.classList.toggle('playing',i===playingTrackIndex)})}
function audioStreamUrl(index){return `/api/audio/stream?customer=${encodeURIComponent(activeCustomer)}&index=${Number(index)}&v=${encodeURIComponent(currentTracks[index]?.name||index)}`}
async function playTrackIndex(index,forceReload=true){
  if(!activeCustomer)throw new Error('Önce müşteri seç.');if(!currentTracks.length)throw new Error('Bu müşteri klasöründe MP3 yok.');
  index=Math.max(0,Math.min(Number(index)||0,currentTracks.length-1));selectedTrack=index;activatePlaybackQueue('customer',currentTracks,index);
  await ensureAudioReady();
  await post('/api/player/stop').catch(()=>{}); // eski ffplay / EQ preview kalmışsa temizle
  if(!forceReload&&playingTrackIndex===index&&webPlayer.src&&!webPlayer.ended){await webPlayer.play();markSelectedTrack();return}
  playingTrackIndex=index;markSelectedTrack();
  $('#nowPlaying').textContent=`Yükleniyor: ${currentTracks[index].name}`;
  webPlayer.src=audioStreamUrl(index);webPlayer.load();
  await webPlayer.play();
  recordShufflePlay(index);
  $('#nowPlaying').textContent=`▶ ${currentTracks[index].name}`;toast(`▶ ${currentTracks[index].name}`);
}
async function playSelected(){const canResume=playingTrackIndex===selectedTrack&&webPlayer.src&&webPlayer.paused&&!webPlayer.ended&&webPlayer.currentTime>0;await playTrackIndex(selectedTrack,!canResume)}
async function playerPause(){if(!webPlayer.src)return;webPlayer.pause();$('#nowPlaying').textContent=`⏸ ${playbackTrack()?.name||'Duraklatıldı'}`;toast('⏸ Duraklatıldı')}
async function playActiveQueueIndex(index){
  if(activePlaybackSource==='customer')return playTrackIndex(index,true);
  if(typeof window.playWinampQueueIndex==='function')return window.playWinampQueueIndex(index,activePlaybackTracks,activePlaybackSource);
}
async function playerPrevious(){
  const tracks=playbackTracks();if(!tracks.length)return;
  if(shuffleEnabled&&shuffleHistory.length>1){
    shuffleHistory.pop();
    const previous=shuffleHistory.pop();
    if(Number.isInteger(previous))return playActiveQueueIndex(previous);
  }
  const active=playbackIndex(),base=Number.isInteger(active)?active:(activePlaybackSource==='customer'?selectedTrack:0);
  await playActiveQueueIndex(Math.max(0,base-1));
}
async function playerNext(auto=false){
  const tracks=playbackTracks();if(!tracks.length)return;
  if(shuffleEnabled){
    const next=nextShuffleIndex();
    if(Number.isInteger(next))return playActiveQueueIndex(next);
    return;
  }
  const active=playbackIndex(),base=Number.isInteger(active)?active:(activePlaybackSource==='customer'?selectedTrack:0);
  const next=base+1;
  if(next>=tracks.length){if(auto){await stopBrowserAudio(false);$('#nowPlaying').textContent='■ Çalma listesi bitti.';toast('Çalma listesi bitti.');return}return playActiveQueueIndex(tracks.length-1)}
  await playActiveQueueIndex(next);
}
async function stopBrowserAudio(killServer=true){
  try{webPlayer.pause()}catch{}
  try{webPlayer.currentTime=0}catch{}
  try{webPlayer.removeAttribute('src');webPlayer.load()}catch{}
  playingTrackIndex=null;activePlaybackIndex=null;markSelectedTrack();window.renderWinampTracks?.(-1);renderBrowserPlayer();
  $('#nowPlaying').textContent='■ Durduruldu';
  if(killServer)await post('/api/player/stop').catch(()=>{});
}
async function playerStop(){await stopYoutubePreview(true);await stopBrowserAudio(true);toast('■ Tüm müzik sesi durduruldu.')}
function playerSeek(seconds,absolute=false){if(!webPlayer.src)return;if(!Number.isFinite(webPlayer.duration)||webPlayer.duration<=0)return;const target=absolute?Number(seconds):(webPlayer.currentTime+Number(seconds));webPlayer.currentTime=Math.max(0,Math.min(webPlayer.duration,target));renderBrowserPlayer()}
function renderBrowserPlayer(){
  const duration=Number.isFinite(webPlayer.duration)?webPlayer.duration:0, position=Number.isFinite(webPlayer.currentTime)?webPlayer.currentTime:0;
  $('#playerTime').textContent=`${fmt(position)} / ${fmt(duration)}`;
  if(!seekDragging){$('#playerSeek').max=Math.max(1,duration||1);$('#playerSeek').value=position||0}
}
function showVolume(v,editing=false){v=Math.max(0,Math.min(100,Number(v)||0));lastVolume=v;if(editing)playerVolumeEditing=true;$('#playerVolume').value=v;$('#previewVolume').value=v;$('#playerVolumeText').textContent=`${v}%`;$('#previewVolumeText').textContent=`${v}%`;return v}
function setBrowserVolume(v,save=true){v=showVolume(v,true);if(audioCtx&&masterGainNode)smoothParam(masterGainNode.gain,v/100,.018);if(save){if(playerVolumeSaveTimer)clearTimeout(playerVolumeSaveTimer);playerVolumeSaveTimer=setTimeout(async()=>{try{await post('/api/config',{player_volume:v})}catch(e){showError(e)}finally{playerVolumeEditing=false}},180)}else{playerVolumeEditing=false}return v}
async function adjustVolume(delta){const v=Math.max(0,Math.min(100,Number($('#playerVolume').value||lastVolume)+Number(delta)));setBrowserVolume(v,true)}
async function applyPreviewVolume(v,immediate=false){v=showVolume(v,true);previewVolumeEditing=true;if(audioCtx&&masterGainNode)smoothParam(masterGainNode.gain,v/100,.018);if(previewVolumeTimer){clearTimeout(previewVolumeTimer);previewVolumeTimer=null}const send=async()=>{try{await post('/api/volume',{volume:v})}finally{previewVolumeEditing=false;playerVolumeEditing=false}};if(immediate)return send();previewVolumeTimer=setTimeout(()=>safeAction(null,send),120)}

async function startPhone(){const d=await post('/api/phone/start');$('#phoneQr').src=d.qr;$('#phoneUrl').textContent=d.url;openModal('phoneModal');toast('Telefon QR hazır — fotoğraf bekleniyor')}
function renderPhone(p){if(p)$('#phoneState').textContent=p.message||''}
async function copyPrompt(){await post('/api/chatgpt/copy-prompt');toast('ChatGPT fotoğraf okuma talimatı panoya kopyalandı')}
async function loadChatgpt(){await post('/api/chatgpt/load-clipboard');toast('ChatGPT listesi yüklendi');await refreshState();closeModal('phoneModal')}
function openModal(id){$('#'+id).classList.remove('hidden')}function closeModal(id){if(id==='searchModal')stopYoutubePreview(true);$('#'+id).classList.add('hidden')}

webPlayer.addEventListener('loadedmetadata',renderBrowserPlayer);
webPlayer.addEventListener('timeupdate',renderBrowserPlayer);
webPlayer.addEventListener('playing',()=>{if(youtubePreviewIndex!=null||youtubePreviewCollectionIndex!=null){const r=youtubePreviewIndex!=null?youtubeResults[youtubePreviewIndex]:collectionTracks[youtubePreviewCollectionIndex];toast(`▶ DİNLENİYOR: ${r?.artist||r?.channel||''}${(r?.artist||r?.channel)?' - ':''}${r?.track_title||r?.title||''}`);if(youtubePreviewIndex!=null)renderYoutube();if(youtubePreviewCollectionIndex!=null)renderCollectionTracks();return}const track=playbackTrack();if(track){$('#nowPlaying').textContent=`▶ ${track.name||'Oynatılıyor'}`;if(activePlaybackSource==='customer')markSelectedTrack();else window.renderWinampTracks?.(activePlaybackIndex)}});
webPlayer.addEventListener('pause',()=>renderBrowserPlayer());
webPlayer.addEventListener('ended',()=>{if(youtubePreviewIndex!=null||youtubePreviewCollectionIndex!=null){stopYoutubePreviewNow(true);toast('■ YouTube ön dinleme bitti.');return}safeAction(null,()=>playerNext(true))});
webPlayer.addEventListener('error',()=>{if(!webPlayer.src)return;const code=webPlayer.error?.code||0;if(youtubePreviewIndex!=null||youtubePreviewCollectionIndex!=null){const r=youtubePreviewIndex!=null?youtubeResults[youtubePreviewIndex]:collectionTracks[youtubePreviewCollectionIndex];stopYoutubePreviewNow(true);showError(new Error(`YouTube anlık dinleme açılamadı${r?.title?': '+r.title:''} (kod ${code}). Tekrar deneyin.`));return}showError(new Error(`MP3 çalma hatası (kod ${code}). Şarkı listesini yenileyip tekrar dene.`))});

$('#downloadModeBtn').onclick=()=>setMode('download');
$('#listenModeBtn').onclick=()=>setMode('listen');
$('#refreshStateBtn').onclick=()=>safeAction($('#refreshStateBtn'),hardRefresh);
$('#stopAllBtn').onclick=()=>safeAction($('#stopAllBtn'),async()=>{await stopYoutubePreview(true);await stopBrowserAudio(false);await post('/api/stop');toast('■ Tüm MP3 / önizleme işlemleri durduruldu.');await refreshState()});
$('#bitrate').onchange=()=>safeAction(null,saveConfig);$('#eqPreset').onchange=()=>safeAction(null,switchEq);$('#listenEqPreset').onchange=e=>applyListeningEqValue(e.target.value,true);$('#customerRoot').onchange=()=>safeAction(null,saveConfig);$('#customerName').oninput=updateTargetPreview;
$('#previewVolume').oninput=e=>applyPreviewVolume(e.target.value,false);$('#previewVolume').onchange=e=>safeAction(null,()=>applyPreviewVolume(e.target.value,true));
$('#loadTextBtn').onclick=()=>safeAction($('#loadTextBtn'),loadText);$('#clearBtn').onclick=()=>safeAction($('#clearBtn'),async()=>{await post('/api/list/clear');selectedSongIndex=null;$('#rawText').value='';await refreshState()});$('#resolveBtn').onclick=()=>safeAction($('#resolveBtn'),startResolve);$('#downloadBtn').onclick=()=>safeAction($('#downloadBtn'),startDownload);
$('#youtubeDurationSortBtn').onclick=()=>sortYoutubeByDuration();
function clearAndFocusYoutubeQuery(){const q=$('#youtubeQuery');if(!q)return;q.value='';setTimeout(()=>{q.focus();try{q.setSelectionRange(0,0)}catch{}},0)}
$('#youtubeSearchBtn').onclick=()=>{openModal('searchModal');clearAndFocusYoutubeQuery()};$('#youtubeRunBtn').onclick=()=>safeAction($('#youtubeRunBtn'),runYoutubeSearch);$('#youtubeQuery').onclick=e=>{e.currentTarget.value=''};$('#youtubeQuery').onkeydown=e=>{if(e.key==='Enter')safeAction($('#youtubeRunBtn'),runYoutubeSearch)};$('#addSelectedYoutubeBtn').onclick=()=>safeAction($('#addSelectedYoutubeBtn'),addSelectedYoutube);$('#artistListsBtn').onclick=()=>safeAction($('#artistListsBtn'),loadArtistLists);$('#selectAllCollectionBtn').onclick=selectAllCollection;$('#addCollectionTracksBtn').onclick=()=>safeAction($('#addCollectionTracksBtn'),addSelectedCollectionTracks);
$('#phoneBtn').onclick=()=>safeAction($('#phoneBtn'),startPhone);$('#copyPromptBtn').onclick=()=>safeAction($('#copyPromptBtn'),copyPrompt);$('#copyPromptPhoneBtn').onclick=()=>safeAction($('#copyPromptPhoneBtn'),copyPrompt);$('#chatgptLoadBtn').onclick=()=>safeAction($('#chatgptLoadBtn'),loadChatgpt);$('#loadClipboardPhoneBtn').onclick=()=>safeAction($('#loadClipboardPhoneBtn'),loadChatgpt);$('#openChatgptBtn').onclick=()=>safeAction($('#openChatgptBtn'),()=>post('/api/chatgpt/open'));$('#copyPhotoBtn').onclick=()=>safeAction($('#copyPhotoBtn'),async()=>{await post('/api/phone/copy-photo');toast('Fotoğraf panoya kopyalandı')});
$('#refreshCustomersBtn').onclick=()=>safeAction($('#refreshCustomersBtn'),()=>refreshCustomers(true));$('#deleteTrackBtn').onclick=()=>safeAction($('#deleteTrackBtn'),deleteSelectedTrack);$('#refreshTracksBtn').onclick=()=>safeAction($('#refreshTracksBtn'),refreshTracks);$('#shuffleBtn').onclick=toggleShuffle;$('#playBtn').onclick=()=>safeAction($('#playBtn'),playSelected);$('#pauseBtn').onclick=()=>safeAction($('#pauseBtn'),playerPause);$('#prevBtn').onclick=()=>safeAction($('#prevBtn'),playerPrevious);$('#nextBtn').onclick=()=>safeAction($('#nextBtn'),()=>playerNext(false));$('#playerStopBtn').onclick=()=>safeAction($('#playerStopBtn'),playerStop);$('#back10Btn').onclick=()=>safeAction($('#back10Btn'),()=>playerSeek(-10,false));$('#forward10Btn').onclick=()=>safeAction($('#forward10Btn'),()=>playerSeek(10,false));
$('#playerVolume').onpointerdown=()=>playerVolumeEditing=true;$('#playerVolume').oninput=e=>setBrowserVolume(e.target.value,true);$('#playerVolume').onchange=e=>setBrowserVolume(e.target.value,true);$('#volumeDownBtn').onclick=()=>safeAction($('#volumeDownBtn'),()=>adjustVolume(-5));$('#volumeUpBtn').onclick=()=>safeAction($('#volumeUpBtn'),()=>adjustVolume(5));
$('#playerSeek').onpointerdown=()=>seekDragging=true;$('#playerSeek').oninput=e=>{if(Number.isFinite(webPlayer.duration))$('#playerTime').textContent=`${fmt(e.target.value)} / ${fmt(webPlayer.duration)}`};$('#playerSeek').onpointercancel=()=>seekDragging=false;$('#playerSeek').onchange=e=>{seekDragging=false;playerSeek(e.target.value,true)};
$('#openDownloadCustomerFolderBtn').onclick=()=>safeAction($('#openDownloadCustomerFolderBtn'),async()=>{const customer=$('#customerName').value.trim();if(!customer)throw new Error('Önce müşteri adı yaz.');await saveConfig();await post('/api/customer/open-folder',{customer});toast('📁 Müşteri klasörü açıldı.')});
$('#openCustomerFolderBtn').onclick=()=>safeAction($('#openCustomerFolderBtn'),async()=>{if(!activeCustomer)throw new Error('Önce müşteri seç.');await post('/api/customer/open-folder',{customer:activeCustomer})});
$('#deleteDownloadCustomerFolderBtn').onclick=()=>safeAction($('#deleteDownloadCustomerFolderBtn'),async()=>{await saveConfig();await deleteCustomerMusicFolder($('#customerName').value.trim())});
$('#deleteCustomerFolderBtn').onclick=()=>safeAction($('#deleteCustomerFolderBtn'),()=>deleteCustomerMusicFolder(activeCustomer));
$('#chooseCustomerRootBtn').onclick=()=>safeAction($('#chooseCustomerRootBtn'),chooseCustomerRoot);
$('#chooseFavoriteFolderBtn').onclick=()=>safeAction($('#chooseFavoriteFolderBtn'),chooseFavoriteFolder);
$('#openFavoriteFolderBtn').onclick=()=>safeAction($('#openFavoriteFolderBtn'),openFavoriteFolder);
$$('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.dataset.close));$$('.modal').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)closeModal(m.id)}));

setInterval(renderBrowserPlayer,200);
setInterval(()=>{if(document.visibilityState==='visible')refreshState()},1100);
setInterval(refreshVisibleCustomerLibrary,2000);
setInterval(()=>{if(!$('#phoneModal').classList.contains('hidden'))api('/api/phone/state?_='+Date.now()).then(d=>renderPhone(d)).catch(()=>{})},1000);
updateShuffleButton();
refreshState();
setTimeout(()=>{restoreAfterPanelReload()},700);
setTimeout(()=>{
  window.winampTracks=[];window.winampFolderTracks=[];window.winampFolders=[];window.winampSavedLocations=[];window.winampCurrentFolder='';window.winampActiveIndex=-1;window.winampActiveToken='';window.winampFavoriteIndexes=new Set();window.winampSource='winamp';window.winampFocusedList='tracks';window.winampTabSavedLocation='';
  let winampFolderHistory=[];try{const saved=JSON.parse(localStorage.getItem('kafepin_winamp_folder_history')||'[]');if(Array.isArray(saved))winampFolderHistory=saved.filter(Boolean).slice(-30)}catch{}let winampFolderHistoryIndex=winampFolderHistory.length-1;let winampFolderRoot=String(localStorage.getItem('kafepin_winamp_folder_root')||'');
  let winampFolderSelections={};try{const saved=JSON.parse(localStorage.getItem('kafepin_winamp_folder_selections')||'{}');if(saved&&typeof saved==='object')winampFolderSelections=saved}catch{}
  const tab=$('#winampModeBtn'),box=$('#winampMode');box.tabIndex=-1;let winampFilter='',winampSearchTimer=null;
  function takeWinampKeyboardFocus(){if(!box.classList.contains('visible'))return;setTimeout(()=>{try{window.focus();box.focus({preventScroll:true})}catch{}},0)}
  window.addEventListener('focus',takeWinampKeyboardFocus);window.addEventListener('pageshow',takeWinampKeyboardFocus);document.addEventListener('visibilitychange',()=>{if(!document.hidden)takeWinampKeyboardFocus()});
  function render(selectedIndex=-1){
    const b=$('#winampRows');b.innerHTML='';
    window.winampTracks.forEach((t,i)=>{if(winampFilter&&!searchKey(`${t.name||''} ${t.source_name||''}`).includes(winampFilter))return;
      const r=document.createElement('tr'),favorite=window.winampSource==='favorites'||window.winampFavoriteIndexes.has(i);r.dataset.winampIndex=String(i);
      r.innerHTML=`<td>${i+1}</td><td><b>${esc(t.name)}</b></td><td>${durationFmt(t.duration_seconds||0)}</td><td>${esc(t.format||'')}</td><td>${esc(t.size_mb)}</td><td><button class="mini-btn quick-favorite${favorite?' is-favorite':''}" title="${favorite?'Favoriden çıkar':'Favori Listem’e ekle'}">${favorite?'★':'☆'}</button></td>`;
      const star=r.querySelector('.quick-favorite');
      star.onclick=e=>{e.stopPropagation();safeAction(star,async()=>{
        if(window.winampSource==='favorites'){
          const d=await post('/api/favorites/remove',{index:i});window.winampTracks=d.tracks||[];window.winampActiveIndex=-1;render();toast(`☆ Favoriden çıkarıldı: ${d.removed||t.name}`);return;
        }
        const d=await post('/api/winamp/favorites/toggle',{index:i});
        if(d.favorite)window.winampFavoriteIndexes.add(i);else window.winampFavoriteIndexes.delete(i);
        render(window.winampActiveIndex);toast(d.favorite?'★ Favori Listem’e kopyalandı':'☆ Favori Listem’den silindi');
      })};
      const activeTrack=activePlaybackSource===window.winampSource?playbackTrack():null;
      const isActiveTrack=Boolean(activeTrack&&(t.token&&activeTrack.token?t.token===activeTrack.token:t.name===activeTrack.name));
      if(i===selectedIndex||(t.token&&t.token===window.winampActiveToken)||isActiveTrack)r.classList.add('selected');
      r.ondblclick=e=>{if(e.target.closest('.quick-favorite'))return;safeAction(r,()=>window.playWinampQueueIndex(i,window.winampTracks,window.winampSource))};
      b.appendChild(r)
    })
  }
  const title=box.querySelector('.card-title span');if(title)title.textContent='🎧 WINAMP MODU • Kalıcı Müzik Klasörleri';
  const folderButton=$('#winampFolderBtn');if(folderButton)folderButton.textContent='📁 MÜZİK KLASÖRÜ EKLE';
  $('#winampUpBtn')?.remove();$('#winampRefreshFolderBtn')?.remove();$('#winampFolderRows')?.closest('.table-wrap')?.remove();
  const locationBar=document.createElement('div');locationBar.id='winampSavedLocations';locationBar.className='playlist-actions wrap';locationBar.style.position='sticky';locationBar.style.top='6px';locationBar.style.zIndex='20';locationBar.style.padding='8px';locationBar.style.background='#12202d';locationBar.style.borderRadius='8px';
  if(!$('#winampSavedLocationStyle')){const style=document.createElement('style');style.id='winampSavedLocationStyle';style.textContent='.winamp-saved-location.selected,.usb-saved-root.selected,.media-saved-root.selected{background:#287a50!important;border-color:#64e79a!important;color:#fff!important;box-shadow:0 0 0 1px #64e79a inset!important}.usb-folder-row.selected,.media-folder.selected,.usb-file-row.selected,.media-file-row.selected{background:#214d3a!important;box-shadow:inset 3px 0 #64e79a!important}.winamp-remove-location,.usb-remove-saved,.media-remove-saved{display:none!important}#mp3ScrollTop{position:fixed;right:18px;bottom:18px;z-index:9999;min-width:44px;font-size:19px;box-shadow:0 3px 14px #0008}';document.head.appendChild(style)}
  $('#winampCurrentFolder')?.parentElement?.insertBefore(locationBar,$('#winampCurrentFolder'));
  locationBar.addEventListener('contextmenu',event=>{const button=event.target.closest('.winamp-saved-location');if(!button)return;event.preventDefault();safeAction(button,async()=>{const path=button.dataset.path;if(!confirm(`“${locationName(path)}” müzik kısayolu kaldırılsın mı?\n\nDosyalar silinmez; yalnız paneldeki kısayol kaldırılır.`))return;window.winampSavedLocations=window.winampSavedLocations.filter(item=>folderKey(item)!==folderKey(path));if(folderKey(window.winampTabSavedLocation)===folderKey(path))window.winampTabSavedLocation='';await post('/api/config',{winamp_saved_locations:window.winampSavedLocations});renderLocations();toast('Klasör kısayolu kaldırıldı; müzik dosyalarına dokunulmadı.')})});
  if(!$('#mp3ScrollTop')){const topButton=document.createElement('button');topButton.id='mp3ScrollTop';topButton.className='mini-btn';topButton.type='button';topButton.title='MP3 panelinin en üstüne git';topButton.textContent='↑';topButton.onclick=()=>{window.scrollTo({top:0,behavior:'smooth'});document.documentElement.scrollTop=0;document.body.scrollTop=0};document.body.appendChild(topButton)}
  let winampSearchRequest=0;
  const winampFilterBox=document.createElement('input');winampFilterBox.id='winampTrackFilter';winampFilterBox.type='search';winampFilterBox.placeholder='🔎 Yeşil ana arşivde sanatçı veya şarkı ara…';winampFilterBox.autocomplete='off';winampFilterBox.style.margin='8px 0';const winampIndexRefresh=document.createElement('button');winampIndexRefresh.type='button';winampIndexRefresh.className='mini-btn';winampIndexRefresh.textContent='↻ MP3 ARŞİV YENİLE';winampIndexRefresh.title='Bu ana arşive yeni müzik eklediysen arama dizinini yeniler';$('#winampCurrentFolder')?.parentElement?.insertBefore(winampFilterBox,locationBar.nextSibling);winampFilterBox.insertAdjacentElement('afterend',winampIndexRefresh);winampIndexRefresh.addEventListener('click',()=>safeAction(winampIndexRefresh,async()=>{const root=window.winampTabSavedLocation||window.winampCurrentFolder;if(!root)throw new Error('Önce bir müzik klasörü seç.');winampSearchRequest++;await post('/api/winamp/search/refresh',{root});toast(`↻ ${locationName(root)} arşivi yenilenmeye hazır.`)}));winampFilterBox.addEventListener('input',()=>{const query=searchKey(winampFilterBox.value),root=window.winampTabSavedLocation||window.winampCurrentFolder,request=++winampSearchRequest;winampFilter=query;clearTimeout(winampSearchTimer);winampSearchTimer=setTimeout(()=>safeAction(winampFilterBox,async()=>{if(request!==winampSearchRequest)return;if(!query){if(root)await browseFolder(root,false);else render(window.winampActiveIndex);return}const d=await post('/api/winamp/search',{query,root});if(request!==winampSearchRequest||folderKey(root)!==folderKey(window.winampTabSavedLocation||window.winampCurrentFolder))return;window.winampSource='winamp';window.winampFolderTracks=d.tracks||[];window.winampTracks=window.winampFolderTracks;window.winampFolders=[];window.winampActiveIndex=-1;render(-1);$('#winampCurrentFolder').textContent=`Hızlı arama • ${locationName(root)}: ${d.search_total||0} sonuç`}),120)});
  winampFilterBox.addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();const first=$('#winampRows')?.querySelector('tr');if(!first){toast('Önce arama sonucunun gelmesini bekle.',true);return}$('#winampRows')?.querySelectorAll('tr').forEach(row=>row.classList.toggle('selected',row===first));window.winampFocusedList='tracks';first.scrollIntoView({block:'center',behavior:'smooth'});box.focus({preventScroll:true})});
  const folderBrowser=document.createElement('div');folderBrowser.className='table-wrap';folderBrowser.innerHTML='<table><thead><tr><th>📁 Alt klasörler — çift tıkla aç</th></tr></thead><tbody id="winampFolderRows"></tbody></table>';
  $('#winampCurrentFolder')?.parentElement?.insertAdjacentElement('afterend',folderBrowser);
  function locationName(path){const parts=String(path||'').split(/[\\/]/).filter(Boolean);return parts.at(-1)||path}
  function saveFolderHistory(){localStorage.setItem('kafepin_winamp_folder_history',JSON.stringify(winampFolderHistory.slice(-30)))}
  function folderKey(path){return String(path||'').toLocaleLowerCase('tr')}
  function isUnderFolder(path,root){const item=folderKey(path),base=folderKey(root).replace(/[\\/]+$/,'');return Boolean(base)&&(item===base||item.startsWith(base+'\\')||item.startsWith(base+'/'))}
  function resetFolderHistory(path){if(!path)return;winampFolderRoot=path;winampFolderHistory=[path];winampFolderHistoryIndex=0;localStorage.setItem('kafepin_winamp_folder_root',path);saveFolderHistory()}
  function restoreFolderHistory(path){if(!path)return;if(!winampFolderRoot||!isUnderFolder(path,winampFolderRoot)||!winampFolderHistory.length){resetFolderHistory(path);return}const known=winampFolderHistory.findIndex(item=>folderKey(item)===folderKey(path));if(known>=0){winampFolderHistoryIndex=known;return}winampFolderHistory=winampFolderHistory.slice(0,winampFolderHistoryIndex+1);winampFolderHistory.push(path);winampFolderHistoryIndex=winampFolderHistory.length-1;saveFolderHistory()}
  function saveFolderSelections(){localStorage.setItem('kafepin_winamp_folder_selections',JSON.stringify(winampFolderSelections))}
  function rememberFolderSelection(parent,child){if(!parent||!child)return;winampFolderSelections[folderKey(parent)]=child;saveFolderSelections()}
  function rememberFolder(path){if(!path)return;const current=winampFolderHistory[winampFolderHistoryIndex];if(current&&current.toLocaleLowerCase('tr')===path.toLocaleLowerCase('tr'))return;winampFolderHistory=winampFolderHistory.slice(0,winampFolderHistoryIndex+1);winampFolderHistory.push(path);if(winampFolderHistory.length>30)winampFolderHistory.shift();winampFolderHistoryIndex=winampFolderHistory.length-1;saveFolderHistory()}
  async function historyBack(){if(winampFolderHistoryIndex<=0)return;winampFolderHistoryIndex--;await browseFolder(winampFolderHistory[winampFolderHistoryIndex],false)}
  async function historyForward(){if(winampFolderHistoryIndex>=winampFolderHistory.length-1)return;winampFolderHistoryIndex++;await browseFolder(winampFolderHistory[winampFolderHistoryIndex],false)}
  async function goWinampRoot(){const root=String(winampFolderRoot||'');if(!root)return;delete winampFolderSelections[folderKey(root)];saveFolderSelections();const d=await post('/api/winamp/browse-folder',{path:root});resetFolderHistory(d.folder||root);await applyFolderState(d,false)}
  function renderLocations(){if(window.winampSavedLocations.length&&!window.winampSavedLocations.some(path=>folderKey(path)===folderKey(window.winampTabSavedLocation)))window.winampTabSavedLocation=window.winampSavedLocations[0];const navigation=`<button class="mini-btn winamp-history-back" ${winampFolderHistoryIndex<=0?'disabled':''}>◀ GERİ</button><button class="mini-btn winamp-history-forward" ${winampFolderHistoryIndex<0||winampFolderHistoryIndex>=winampFolderHistory.length-1?'disabled':''}>İLERİ ▶</button>`;const shortcuts=window.winampSavedLocations.map(path=>`<span class="saved-location-pair"><button class="mini-btn winamp-saved-location${folderKey(path)===folderKey(window.winampTabSavedLocation)?' selected':''}" data-path="${esc(path)}">📌 ${esc(locationName(path))}</button><button class="mini-btn danger winamp-remove-location" data-path="${esc(path)}" title="Yalnız kısayolu kaldır">×</button></span>`).join('')||'<span class="note">Henüz kayıtlı müzik klasörü yok.</span>';locationBar.innerHTML=navigation+shortcuts;locationBar.querySelector('.winamp-history-back')?.addEventListener('click',button=>safeAction(button.currentTarget,historyBack));locationBar.querySelector('.winamp-history-forward')?.addEventListener('click',button=>safeAction(button.currentTarget,historyForward));locationBar.querySelectorAll('.winamp-saved-location').forEach(button=>button.onclick=()=>safeAction(button,async()=>{window.winampTabSavedLocation=button.dataset.path;window.winampFocusedList='saved';await browseFolder(button.dataset.path,true,'',true)}));locationBar.querySelectorAll('.winamp-remove-location').forEach(button=>button.onclick=()=>safeAction(button,async()=>{const path=button.dataset.path;window.winampSavedLocations=window.winampSavedLocations.filter(item=>item.toLocaleLowerCase('tr')!==path.toLocaleLowerCase('tr'));if(folderKey(window.winampTabSavedLocation)===folderKey(path))window.winampTabSavedLocation='';await post('/api/config',{winamp_saved_locations:window.winampSavedLocations});renderLocations();toast('Klasör kısayolu kaldırıldı; müzik dosyalarına dokunulmadı.')}));$('#winampCurrentFolder').textContent=`Seçili müzik klasörü: ${window.winampCurrentFolder||'-'}`}
  function renderFolders(){const rows=$('#winampFolderRows');if(!rows)return;const ignoredArtwork=new Set(['cover','covers','artwork','album art','albumart']);const folders=(window.winampFolders||[]).filter(folder=>!(window.winampTracks.length&&ignoredArtwork.has(String(folder.name||'').trim().toLocaleLowerCase('tr'))));const remembered=winampFolderSelections[folderKey(window.winampCurrentFolder)];rows.innerHTML=folders.map(folder=>`<tr class="winamp-folder-row${folderKey(folder.path)===folderKey(remembered)?' selected':''}" data-path="${esc(folder.path)}"><td>📁 <b>${esc(folder.name)}</b></td></tr>`).join('')||'<tr><td class="note">Alt müzik klasörü yok.</td></tr>';const folderRows=[...rows.querySelectorAll('.winamp-folder-row')];if(folderRows.length&&!rows.querySelector('.winamp-folder-row.selected')){folderRows[0].classList.add('selected');rememberFolderSelection(window.winampCurrentFolder,folderRows[0].dataset.path)}folderRows.forEach(row=>{row.onclick=()=>{window.winampFocusedList='folders';rows.querySelectorAll('.winamp-folder-row').forEach(item=>item.classList.toggle('selected',item===row));rememberFolderSelection(window.winampCurrentFolder,row.dataset.path)};row.ondblclick=()=>safeAction(row,()=>browseFolder(row.dataset.path,true,window.winampCurrentFolder))});const selected=rows.querySelector('.winamp-folder-row.selected');if(selected){window.winampFocusedList='folders';requestAnimationFrame(()=>selected.scrollIntoView({block:'center',behavior:'instant'}))}}
  async function applyFolderState(d,notify=false){window.winampSource='winamp';window.winampFolderTracks=d.tracks||[];window.winampTracks=window.winampFolderTracks;window.winampFolders=d.folders||[];window.winampCurrentFolder=d.folder||'';const activeTrack=activePlaybackSource==='winamp'?playbackTrack():null;const activeIndex=activeTrack?window.winampTracks.findIndex(track=>track.token&&activeTrack.token?track.token===activeTrack.token:track.name===activeTrack.name):-1;if(activeIndex>=0){window.winampActiveIndex=activeIndex;window.winampActiveToken=window.winampTracks[activeIndex].token||''}else if(activePlaybackSource==='winamp'){window.winampActiveIndex=-1;window.winampActiveToken=''}window.winampSavedLocations=Array.isArray(d.saved_locations)?d.saved_locations:window.winampSavedLocations;const trackHeader=$('#winampRows')?.closest('table')?.querySelector('thead tr');if(trackHeader)trackHeader.innerHTML=`<th>#</th><th>🎵 Parçalar (${window.winampTracks.length})</th><th>Süre</th><th>Tür</th><th>MB</th><th>Favori</th>`;renderLocations();renderFolders();await window.refreshWinampFavoriteState();if(!(window.winampFolders||[]).length&&window.winampTracks.length){const rows=[...$('#winampRows')?.querySelectorAll('tr')||[]];if(rows.length&&!rows.some(row=>row.classList.contains('selected'))){rows[0].classList.add('selected');window.winampFocusedList='tracks';requestAnimationFrame(()=>rows[0].scrollIntoView({block:'center',behavior:'instant'}))}}if(notify)toast(`${window.winampTracks.length} müzik • klasör kalıcı olarak hatırlandı`)}
  async function browseFolder(path,remember=true,previousFolder='',asNewRoot=false){if(!path)throw new Error('Müzik klasörü bulunamadı.');winampSearchRequest++;winampFilter='';if(winampFilterBox)winampFilterBox.value='';if(previousFolder)rememberFolderSelection(previousFolder,path);const d=await post('/api/winamp/browse-folder',{path});if(asNewRoot)resetFolderHistory(d.folder||path);else if(remember)rememberFolder(d.folder||path);window.winampFocusedList='tracks';await applyFolderState(d,true)}
  async function toggleSelectedWinampFavorites(){const rows=[...$('#winampRows')?.querySelectorAll('tr.selected')||[]],indexes=rows.map(row=>Number(row.dataset.winampIndex)).filter(index=>Number.isInteger(index)&&index>=0);if(!indexes.length)throw new Error('Önce bir şarkı seç.');if(window.winampSource==='favorites'){let next=window.winampTracks;for(const index of [...indexes].sort((a,b)=>b-a)){const d=await post('/api/favorites/remove',{index});next=d.tracks||[]}window.winampTracks=next;activePlaybackTracks=activePlaybackSource==='favorites'?next:activePlaybackTracks;await window.refreshWinampFavoriteState();toast('☆ Seçilen şarkı favoriden çıkarıldı.');return}let added=0,removed=0;for(const index of indexes){const d=await post('/api/winamp/favorites/toggle',{index});if(d.favorite)added++;else removed++}await window.refreshWinampFavoriteState();toast(added&&removed?`★ ${added} eklendi • ☆ ${removed} çıkarıldı`:added?`★ ${added} şarkı Favori Listem’e eklendi.`:`☆ ${removed} şarkı Favori Listem’den çıkarıldı.`)}
  async function playSelectedWinampTrack(){const row=$('#winampRows')?.querySelector('tr.selected');if(!row)throw new Error('Önce bir şarkı seç.');const index=Number(row.dataset.winampIndex);if(!Number.isInteger(index)||index<0)throw new Error('Seçilen şarkı bulunamadı.');const current=window.winampTracks[index];if(activePlaybackSource===window.winampSource&&activePlaybackIndex===index&&playbackTrack()?.name===current?.name){if(webPlayer.paused){await webPlayer.play();toast(`▶ ${current.name}`)}else{webPlayer.pause();toast(`Ⅱ ${current.name} duraklatıldı.`)}return}await window.playWinampQueueIndex(index,window.winampTracks,window.winampSource)}
  function ensureWinampKeyboardFocus(){const folderRows=[...$('#winampFolderRows')?.querySelectorAll('.winamp-folder-row')||[]],trackRows=[...$('#winampRows')?.querySelectorAll('tr')||[]];if(window.winampSource!=='favorites'&&folderRows.length){const selected=$('#winampFolderRows')?.querySelector('.winamp-folder-row.selected')||folderRows[0];selected.classList.add('selected');rememberFolderSelection(window.winampCurrentFolder,selected.dataset.path);window.winampFocusedList='folders';selected.scrollIntoView({block:'center',behavior:'instant'});return}if(trackRows.length){const selected=$('#winampRows')?.querySelector('tr.selected')||trackRows[0];selected.classList.add('selected');window.winampFocusedList='tracks';selected.scrollIntoView({block:'center',behavior:'instant'})}}
  function moveWinampSelection(delta){let rows,folderMode=window.winampFocusedList==='folders';if(folderMode)rows=[...$('#winampFolderRows')?.querySelectorAll('.winamp-folder-row')||[]];else rows=[...$('#winampRows')?.querySelectorAll('tr')||[]];if(!rows.length&&folderMode){folderMode=false;window.winampFocusedList='tracks';rows=[...$('#winampRows')?.querySelectorAll('tr')||[]]}if(!rows.length)return;let current=rows.findIndex(row=>row.classList.contains('selected'));let next=current<0?(delta>=0?0:rows.length-1):Math.max(0,Math.min(rows.length-1,current+delta));rows.forEach((row,index)=>row.classList.toggle('selected',index===next));const row=rows[next];if(folderMode)rememberFolderSelection(window.winampCurrentFolder,row.dataset.path);row.scrollIntoView({block:'center',behavior:'instant'})}
  async function selectSavedWinampLocation(path){if(!path)return;window.winampTabSavedLocation=path;delete winampFolderSelections[folderKey(path)];saveFolderSelections();await browseFolder(path,true,'',true);window.winampFocusedList='folders';locationBar.querySelector('.winamp-saved-location.selected')?.scrollIntoView({block:'nearest',inline:'center',behavior:'instant'})}
  async function moveSavedWinampLocation(delta){const paths=window.winampSavedLocations||[];if(!paths.length)return;let index=paths.findIndex(path=>folderKey(path)===folderKey(window.winampTabSavedLocation));index=(index<0?(delta>=0?-1:0):index)+delta;if(index<0)index=paths.length-1;if(index>=paths.length)index=0;await selectSavedWinampLocation(paths[index])}
  async function openFocusedWinampItem(){if(window.winampFocusedList==='saved'&&window.winampTabSavedLocation)return browseFolder(window.winampTabSavedLocation,true,'',true);if(window.winampFocusedList==='folders'){const row=$('#winampFolderRows')?.querySelector('.winamp-folder-row.selected');if(row)return browseFolder(row.dataset.path,true,window.winampCurrentFolder)}return playSelectedWinampTrack()}
  document.addEventListener('keydown',event=>{const target=event.target;if(!box.classList.contains('visible')||target?.matches?.('input,textarea,select'))return;const plain=!event.altKey&&!event.ctrlKey&&!event.metaKey;if(plain&&event.key==='Escape'){event.preventDefault();safeAction(null,goWinampRoot)}else if(plain&&event.key==='ArrowLeft'){event.preventDefault();if(webPlayer.src&&!webPlayer.paused&&!webPlayer.ended)playerSeek(-10,false);else safeAction(null,historyBack)}else if(plain&&event.key==='ArrowRight'){event.preventDefault();if(webPlayer.src&&!webPlayer.paused&&!webPlayer.ended)playerSeek(10,false);else safeAction(null,historyForward)}else if(plain&&event.key==='ArrowDown'){event.preventDefault();moveWinampSelection(1)}else if(plain&&event.key==='ArrowUp'){event.preventDefault();moveWinampSelection(-1)}else if(plain&&event.key==='Tab'){event.preventDefault();safeAction(null,()=>moveSavedWinampLocation(event.shiftKey?-1:1))}else if(plain&&event.key==='Enter'){event.preventDefault();safeAction(null,openFocusedWinampItem)}else if(plain&&event.key.toLocaleLowerCase('tr')==='f'){event.preventDefault();safeAction(null,toggleSelectedWinampFavorites)}},true);
  window.renderWinampTracks=render;
  window.playWinampQueueIndex=async(index,tracks=window.winampTracks,source=window.winampSource)=>{const list=Array.isArray(tracks)?tracks:[];if(!list.length)throw new Error('Çalınacak müzik yok.');index=Math.max(0,Math.min(Number(index)||0,list.length-1));const track=list[index];await ensureAudioReady();stopYoutubePreviewNow(true);activatePlaybackQueue(source,list,index);window.winampSource=source;window.winampTracks=list;const endpoint=source==='favorites'?'/api/favorites/stream':'/api/winamp/stream',token=track.token?`&token=${encodeURIComponent(track.token)}`:'';webPlayer.src=`${endpoint}?index=${index}${token}&v=${encodeURIComponent(track.name)}`;webPlayer.load();await webPlayer.play();recordShufflePlay(index);render(index);$('#nowPlaying').textContent=`▶ ${track.name}`;toast(`▶ ${track.name}`)};
  window.refreshWinampFavoriteState=async()=>{if(window.winampSource==='favorites'){window.winampFavoriteIndexes=new Set(window.winampTracks.map((_,i)=>i));render(window.winampActiveIndex);return}const d=await api('/api/winamp/favorites/state?_='+Date.now());window.winampFavoriteIndexes=new Set((d.indexes||[]).map(Number));render(window.winampActiveIndex)};
  tab.onclick=()=>safeAction(tab,async()=>{if(activePlaybackSource==='favorites'&&activePlaybackTracks.length&&Number.isInteger(activePlaybackIndex)){window.winampSource='favorites';window.winampTracks=activePlaybackTracks}else{window.winampSource='winamp';window.winampTracks=window.winampFolderTracks}openWinampPlayback();if(window.winampSavedLocations.length){await selectSavedWinampLocation(window.winampSavedLocations[0]);takeWinampKeyboardFocus()}else{ensureWinampKeyboardFocus();takeWinampKeyboardFocus()}});const old=setMode;window.setMode=mode=>{old(mode);box.classList.toggle('visible',mode==='winamp');tab.classList.toggle('active',mode==='winamp');if(mode==='winamp')takeWinampKeyboardFocus()};
  $('#winampFolderBtn').onclick=()=>safeAction($('#winampFolderBtn'),async()=>{const d=await post('/api/winamp/choose-folder');resetFolderHistory(d.folder);await applyFolderState(d,true)});
  api('/api/winamp/current-folder?_='+Date.now()).then(async d=>{let initial;const firstSaved=(Array.isArray(d.saved_locations)?d.saved_locations:[])[0]||'';if(firstSaved){initial=folderKey(d.folder)===folderKey(firstSaved)?d:await post('/api/winamp/browse-folder',{path:firstSaved});resetFolderHistory(initial.folder||firstSaved);window.winampTabSavedLocation=firstSaved}else if(!winampFolderRoot){resetFolderHistory(d.folder);initial=d}else{const start=winampFolderRoot;initial=folderKey(d.folder)===folderKey(start)?d:await post('/api/winamp/browse-folder',{path:start});resetFolderHistory(initial.folder)}await applyFolderState(initial,false);if(window.winampSavedLocations.length){openWinampPlayback();await selectSavedWinampLocation(window.winampSavedLocations[0]);takeWinampKeyboardFocus()}}).catch(()=>renderLocations())
},0);

// v2.34.30 Film/Oyun USB satışları — MP3 müşteri listesinden tamamen bağımsız.
setTimeout(()=>{
  function setupMediaUsb(o){
    const tab=$('#'+o.tab),box=$('#'+o.box);if(!tab||!box)return;
    let sources=[],folder='',parent='',transaction=null,saved=[],savedSelected='',folderSelected='',fileSelected='',browserFocus='folder',selectedFilePaths=new Set(),mediaFilter='',mediaFilterTimer=null,lastBrowser=null,browserRequest=0;
    const el=name=>$('#'+o.p+name);
    el('Roots').addEventListener('contextmenu',event=>{const button=event.target.closest('.media-saved-root');if(!button)return;event.preventDefault();safeAction(button,async()=>{const path=button.dataset.path;if(!confirm(`“${path.split(/[\\/]/).filter(Boolean).pop()||path}” kısayolu kaldırılsın mı?\n\nKaynak dosyalar silinmez.`))return;saved=saved.filter(item=>item!==path);if(savedSelected===path)savedSelected=saved[0]||'';await post('/api/config',{[o.cfgLocations]:saved});renderBrowser(await api(`${o.api}/browser?path=${encodeURIComponent(folder||'')}&_=${Date.now()}`));toast('Kısayol kaldırıldı; kaynak dosyalara dokunulmadı.')})});
    const data=()=>({drive:el('Drive').value,folder_name:el('FolderName').value.trim()||o.defaultFolder,
      unit_price:Number(el('UnitPrice').value||0),payment_method:el('Payment').value,
      layout:el('Layout')?.value,profile:el('Profile')?.value,shuffle:false});
    function renderSources(rows){sources=rows||[];const list=el('SourceList');if(!sources.length){list.innerHTML='<div class="usb-empty">Henüz klasör veya dosya eklenmedi.</div>';return}list.innerHTML=sources.map(x=>`<div class="usb-source-item"><span>${x.kind==='folder'?'📁 KLASÖR':'📄 DOSYA'} • <b>${esc(x.name)}</b><small>${esc(x.path)}</small></span><button class="mini-btn danger media-remove" data-id="${esc(x.id)}">KALDIR</button></div>`).join('');list.querySelectorAll('.media-remove').forEach(b=>b.onclick=()=>safeAction(b,async()=>{const d=await post(`${o.api}/sources/remove`,{id:b.dataset.id});renderSources(d.sources)}))}
    function renderBrowser(d){folder=d.folder||'';parent=d.parent||'';if(saved.length&&!saved.some(path=>path===savedSelected))savedSelected=saved[0];el('Path').textContent=`Klasör: ${folder||'-'} • Seçili dosya: ${selectedFilePaths.size}`;el('UpBtn').disabled=!parent;const savedButtons=saved.map(path=>`<button class="mini-btn media-saved-root${path===savedSelected?' selected':''}" data-path="${esc(path)}">📌 ${esc(path.split(/[\\/]/).filter(Boolean).pop()||path)}</button><button class="mini-btn danger media-remove-saved" data-path="${esc(path)}" title="Bu arşiv kısayolunu kaldır">×</button>`).join('');const actions=`<button class="mini-btn media-choose-root">📂 KLASÖR SEÇ</button>${folder?'<button class="mini-btn media-save-location">📌 BU KONUMU KAYDET</button>':''}`;el('Roots').innerHTML=savedButtons+actions;const folders=d.folders||[],files=d.files||[];if(!folders.some(x=>x.path===folderSelected))folderSelected=folders[0]?.path||'';if(!files.some(x=>x.path===fileSelected))fileSelected=files[0]?.path||'';el('Roots').querySelectorAll('.media-saved-root').forEach(b=>b.onclick=()=>safeAction(b,()=>selectSavedRoot(b.dataset.path)));el('Roots').querySelector('.media-choose-root')?.addEventListener('click',()=>safeAction(el('Roots'),async()=>{renderBrowser(await api(`${o.api}/browser/choose?path=${encodeURIComponent(folder||'')}&_=${Date.now()}`))}));el('Roots').querySelector('.media-save-location')?.addEventListener('click',()=>safeAction(el('Roots'),async()=>{if(!folder)return;const next=[...saved.filter(x=>x!==folder),folder].slice(-12);await post('/api/config',{[o.cfgLocations]:next});saved=next;savedSelected=folder;renderBrowser(d);toast('📌 Arşiv konumu kalıcı kısayollara eklendi.')}));el('Roots').querySelectorAll('.media-remove-saved').forEach(b=>b.onclick=()=>safeAction(b,async()=>{const next=saved.filter(x=>x!==b.dataset.path);await post('/api/config',{[o.cfgLocations]:next});saved=next;renderBrowser(d)}));el('FolderRows').innerHTML=folders.length?folders.map(x=>`<tr class="media-folder${x.path===folderSelected&&browserFocus==='folder'?' selected':''}" data-path="${esc(x.path)}"><td>📁 <b>${esc(x.name)}</b></td></tr>`).join(''):'<tr><td class="usb-empty">Alt klasör yok.</td></tr>';el('FolderRows').querySelectorAll('.media-folder').forEach(r=>{r.onclick=()=>{browserFocus='folder';folderSelected=r.dataset.path;renderBrowser(d)};r.ondblclick=()=>browse(r.dataset.path)});el('FileRows').innerHTML=files.length?files.map(x=>`<tr class="media-file-row${x.path===fileSelected&&browserFocus==='file'?' selected':''}" data-path="${esc(x.path)}"><td class="usb-check-cell"><input class="media-file-check" type="checkbox" data-path="${esc(x.path)}" ${selectedFilePaths.has(x.path)?'checked':''}></td><td>${o.icon} ${esc(x.name)}</td><td>${x.size_mb}</td></tr>`).join(''):'<tr><td colspan="3" class="usb-empty">Bu klasörde uygun dosya yok.</td></tr>';el('FileRows').querySelectorAll('.media-file-row').forEach(r=>r.onclick=e=>{if(e.target.matches('.media-file-check'))return;browserFocus='file';fileSelected=r.dataset.path;renderBrowser(d)});el('FileRows').querySelectorAll('.media-file-check').forEach(check=>check.onchange=()=>{check.checked?selectedFilePaths.add(check.dataset.path):selectedFilePaths.delete(check.dataset.path);el('Path').textContent=`Klasör: ${folder||'-'} • Seçili dosya: ${selectedFilePaths.size}`})}
    const rawRenderBrowser=renderBrowser;
    const filterBox=document.createElement('input');filterBox.id=o.p+'BrowserFilter';filterBox.type='search';filterBox.placeholder='🔎 Yalnız bu klasörde ara…';filterBox.autocomplete='off';filterBox.style.margin='8px 0';el('Roots')?.insertAdjacentElement('afterend',filterBox);filterBox.addEventListener('input',()=>{mediaFilter=searchKey(filterBox.value);clearTimeout(mediaFilterTimer);mediaFilterTimer=setTimeout(()=>{if(lastBrowser)renderBrowser(lastBrowser)},80)});
    renderBrowser=function(d){lastBrowser=d||lastBrowser||{};const matches=item=>!mediaFilter||searchKey(`${item.name||''} ${item.source_name||''}`).includes(mediaFilter);const view={...lastBrowser,folders:(lastBrowser.folders||[]).filter(matches),files:(lastBrowser.files||[]).filter(matches)};rawRenderBrowser(view);const pathText=el('Path');if(pathText&&mediaFilter)pathText.textContent=`Klasör: ${lastBrowser.folder||'-'} • Arama: ${view.folders.length+view.files.length} sonuç • Seçili dosya: ${selectedFilePaths.size}`};
    async function browse(path){const request=++browserRequest;const d=await api(`${o.api}/browser?path=${encodeURIComponent(path||'')}&_=${Date.now()}`);if(request!==browserRequest)return;renderBrowser(d)}
    async function selectSavedRoot(path){savedSelected=path;folderSelected='';fileSelected='';browserFocus='folder';await browse(path)}
    async function moveSavedRoot(delta){if(!saved.length)return;let i=saved.indexOf(savedSelected);i=(i<0?0:i)+delta;if(i<0)i=saved.length-1;if(i>=saved.length)i=0;await selectSavedRoot(saved[i])}
    function moveFolder(delta){const rows=[...el('FolderRows').querySelectorAll('.media-folder')];if(!rows.length)return;let i=rows.findIndex(r=>r.dataset.path===folderSelected);i=Math.max(0,Math.min(rows.length-1,(i<0?0:i)+delta));folderSelected=rows[i].dataset.path;rows.forEach((r,n)=>r.classList.toggle('selected',n===i));rows[i].scrollIntoView({block:'center',behavior:'instant'})}
    function moveFile(delta){const rows=[...el('FileRows').querySelectorAll('.media-file-row')];if(!rows.length)return;let i=rows.findIndex(r=>r.dataset.path===fileSelected);i=Math.max(0,Math.min(rows.length-1,(i<0?0:i)+delta));fileSelected=rows[i].dataset.path;rows.forEach((r,n)=>r.classList.toggle('selected',n===i));rows[i].scrollIntoView({block:'center',behavior:'instant'})}
    function toggleSelectedFile(){const row=el('FileRows').querySelector(`.media-file-row[data-path="${CSS.escape(fileSelected)}"]`);const check=row?.querySelector('.media-file-check');if(!check)return;check.checked=!check.checked;check.checked?selectedFilePaths.add(fileSelected):selectedFilePaths.delete(fileSelected);el('Path').textContent=`Klasör: ${folder||'-'} • Seçili dosya: ${selectedFilePaths.size}`}
    function renderPlan(p){el('Plan').innerHTML=`Bulunan ${o.item}: <b>${p.source_count}</b><br>USB’de bulunan/tekrar: <b>${p.duplicate_count}</b><br>Aktarılacak: <b>${p.copy_count}</b> • ${p.size_mb} MB<br>${p.filesystem?`USB biçimi: <b>${p.filesystem}</b><br>`:''}<strong>TOPLAM: ${Number(p.total_price).toFixed(2)} TL</strong>${p.fat32_blocked?'<br><span class="danger-note">4 GB üstü dosya var: exFAT veya NTFS seç.</span>':''}`}
    function renderTx(tx){transaction=tx||null;const area=el('Transaction');if(!tx||!['pending','submitting','uncertain','completed'].includes(tx.status)){area.classList.add('hidden-row');area.innerHTML='';return}area.classList.remove('hidden-row');area.innerHTML=`<b>${tx.status==='completed'?`KafePin’e işlendi • #${tx.sale_id}`:'Satış onayı bekliyor'}</b><br>${tx.copied} ${o.item} • ${Number(tx.total_price).toFixed(2)} TL<div class="toolbar wrap">${tx.status==='pending'?`<button class="btn accent media-confirm">KAFEPİN DOĞRUDAN SATIŞA EKLE</button><button class="btn media-cancel">İPTAL • DOSYALAR KALSIN</button><button class="btn danger media-delete">AKTARILANLARI SİL + İPTAL</button>`:''}</div>`;area.querySelector('.media-confirm')?.addEventListener('click',e=>safeAction(e.currentTarget,async()=>{if(!confirm(`${tx.total_price} TL KafePin'e eklensin mi?`))return;const d=await post(`${o.api}/confirm-sale`,{transaction_id:tx.id});renderTx(d.transaction)}));area.querySelector('.media-cancel')?.addEventListener('click',e=>safeAction(e.currentTarget,async()=>{const d=await post(`${o.api}/cancel-sale`,{transaction_id:tx.id,remove_files:false});renderTx(d.transaction)}));area.querySelector('.media-delete')?.addEventListener('click',e=>safeAction(e.currentTarget,async()=>{if(!confirm('Yalnız son aktarımda kopyalananlar USB’den silinsin mi?'))return;const d=await post(`${o.api}/cancel-sale`,{transaction_id:tx.id,remove_files:true});renderTx(d.transaction)}))}
    async function load(){const oldDrive=el('Drive').value,d=await api(`${o.api}/state?_=${Date.now()}`),cfg=d.config||{};saved=Array.isArray(cfg[o.cfgLocations])?cfg[o.cfgLocations]:[];el('Drive').innerHTML=(d.drives||[]).length?d.drives.map(x=>`<option value="${esc(x.drive)}">${esc(x.drive)} ${esc(x.label)} • ${x.free_gb} GB boş</option>`).join(''):'<option value="">Takılı USB yok</option>';if(oldDrive&&[...el('Drive').options].some(x=>x.value===oldDrive))el('Drive').value=oldDrive;el('FolderName').value=cfg[o.cfgFolder]||o.defaultFolder;if(document.activeElement!==el('UnitPrice'))el('UnitPrice').value=Number(cfg[o.cfgPrice]??o.defaultPrice);el('Payment').value=cfg[o.cfgPayment]||'CASH';if(el('Layout'))el('Layout').value=cfg.usb_film_layout||'folders';if(el('Profile'))el('Profile').value=cfg.usb_film_profile||'original';renderSources(d.sources);renderBrowser(d.browser);if(saved.length)await selectSavedRoot(saved[0]);renderTx(d.transaction)}
    tab.onclick=()=>{$$('.mode').forEach(x=>x.classList.remove('visible'));box.classList.add('visible');$$('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');safeAction(tab,load)};
    ['downloadModeBtn','listenModeBtn','winampModeBtn','favoritesModeBtn','usbModeBtn',o.otherTab].forEach(id=>$('#'+id)?.addEventListener('click',()=>box.classList.remove('visible')));
    document.addEventListener('keydown',event=>{if(!box.classList.contains('visible')||event.target?.matches?.('input,textarea,select')||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='Tab'){event.preventDefault();safeAction(null,()=>moveSavedRoot(event.shiftKey?-1:1))}else if(event.key==='ArrowRight'&&o.p!=='game'){event.preventDefault();browserFocus='file';moveFile(0)}else if(event.key==='ArrowLeft'&&o.p!=='game'){event.preventDefault();browserFocus='folder';moveFolder(0)}else if(event.key==='ArrowDown'){event.preventDefault();o.p==='game'||browserFocus==='folder'?moveFolder(1):moveFile(1)}else if(event.key==='ArrowUp'){event.preventDefault();o.p==='game'||browserFocus==='folder'?moveFolder(-1):moveFile(-1)}else if(event.key==='Enter'){event.preventDefault();if(o.p==='game'&&folderSelected)safeAction(null,async()=>{renderSources((await post(`${o.api}/sources/add`,{paths:[folderSelected]})).sources);toast('🎮 Seçili oyun klasörü aktarım listesine eklendi.')});else if(browserFocus==='file')toggleSelectedFile();else if(folderSelected)safeAction(null,()=>browse(folderSelected))}else if(event.key==='Escape'){event.preventDefault();if(savedSelected)safeAction(null,()=>selectSavedRoot(savedSelected))}},true);
    el('RefreshBtn').onclick=()=>safeAction(el('RefreshBtn'),load);el('UpBtn').onclick=()=>safeAction(el('UpBtn'),()=>browse(parent));
    el('AddFolderBtn').onclick=()=>safeAction(el('AddFolderBtn'),async()=>{if(!folder)throw new Error('Önce klasör aç.');renderSources((await post(`${o.api}/sources/add`,{paths:[folder]})).sources)});
    el('AddFilesBtn').onclick=()=>safeAction(el('AddFilesBtn'),async()=>{const paths=[...selectedFilePaths];if(!paths.length)throw new Error('Önce dosya işaretle.');renderSources((await post(`${o.api}/sources/add`,{paths})).sources);selectedFilePaths.clear();await browse(folder)});
    el('ClearBtn').onclick=()=>safeAction(el('ClearBtn'),async()=>renderSources((await post(`${o.api}/sources/clear`,{})).sources));
    el('UnitPrice').onchange=()=>safeAction(el('UnitPrice'),()=>post('/api/config',{[o.cfgPrice]:Number(el('UnitPrice').value||0)}));
    el('PreviewBtn').onclick=()=>safeAction(el('PreviewBtn'),async()=>renderPlan((await post(`${o.api}/preview`,data())).plan));
    el('TransferBtn').onclick=()=>safeAction(el('TransferBtn'),async()=>{const d0=data();if(!d0.drive)throw new Error('Önce USB seç.');if(!sources.length)throw new Error('Önce klasör veya dosya ekle.');const preview=(await post(`${o.api}/preview`,d0)).plan;renderPlan(preview);if(preview.fat32_blocked)throw new Error('4 GB üstü dosya için USB’yi exFAT veya NTFS biçimlendir.');if(!preview.copy_count)return toast('Yeni aktarılacak dosya yok.');if(!confirm(`${preview.copy_count} ${o.item} aktarılsın mı? Toplam ${preview.total_price} TL.`))return;const d=await post(`${o.api}/transfer`,d0);renderTx(d.result.transaction);toast(`✓ ${d.result.copied} aktarıldı • ${d.result.duplicate_count} tekrar`)});
    el('FormatBtn').onclick=()=>safeAction(el('FormatBtn'),async()=>{const drive=el('Drive').value;if(!drive)throw new Error('USB bulunamadı.');const letter=drive[0].toUpperCase(),fs=el('Filesystem').value;if(!confirm(`${drive} içindeki TÜM DOSYALAR SİLİNECEK. ${fs} yapılsın mı?`))return;const typed=prompt(`FORMAT ${letter} yazın.`,'');if(typed!==`FORMAT ${letter}`)throw new Error('Biçimlendirme iptal edildi.');await post(`${o.api}/format`,{drive,filesystem:fs,label:el('Label').value,confirmation:typed});await load();toast(`✓ ${drive} ${fs} biçimlendirildi.`)});
  }
  setupMediaUsb({p:'film',tab:'usbFilmModeBtn',box:'usbFilmMode',otherTab:'usbGameModeBtn',api:'/api/usb-film',icon:'🎬',item:'film',defaultFolder:'Filmler',defaultPrice:50,cfgPrice:'usb_film_unit_price',cfgFolder:'usb_film_folder_name',cfgPayment:'usb_film_payment_method',cfgLocations:'usb_film_saved_locations'});
  setupMediaUsb({p:'game',tab:'usbGameModeBtn',box:'usbGameMode',otherTab:'usbFilmModeBtn',api:'/api/usb-game',icon:'🎮',item:'oyun/paket',defaultFolder:'Oyunlar',defaultPrice:100,cfgPrice:'usb_game_unit_price',cfgFolder:'usb_game_folder_name',cfgPayment:'usb_game_payment_method',cfgLocations:'usb_game_saved_locations'});
},0);
setTimeout(()=>{$('#downloadModeBtn').addEventListener('click',()=>$('#winampMode').classList.remove('visible'));$('#listenModeBtn').addEventListener('click',()=>$('#winampMode').classList.remove('visible'))},0);
setTimeout(()=>{const rows=$('#winampRows'),fav=$('#winampFavoriteBtn');if(!rows||!fav)return;rows.addEventListener('click',e=>{if(e.target.closest('.quick-favorite'))return;const row=e.target.closest('tr');if(!row)return;window.winampFocusedList='tracks';row.classList.toggle('selected',!e.ctrlKey&&!e.shiftKey?true:!row.classList.contains('selected'));if(!e.ctrlKey&&!e.shiftKey)rows.querySelectorAll('tr').forEach(x=>{if(x!==row)x.classList.remove('selected')})});fav.onclick=()=>safeAction(fav,async()=>{if(window.winampSource==='favorites')throw new Error('Bu parçalar zaten Favori Listem klasöründe.');const indexes=[...rows.querySelectorAll('tr.selected')].map(row=>[...rows.children].indexOf(row));const d=await post('/api/winamp/favorites/add',{indexes});await window.refreshWinampFavoriteState?.();toast(`⭐ ${d.added} şarkı Favori Listem klasörüne kopyalandı`)})},0);
setTimeout(()=>{const tab=$('#winampModeBtn'),listen=$('#listenModeBtn'),player=$('#listenMode .player-card'),listenGrid=$('#listenMode .listen-grid'),winamp=$('#winampMode');if(!tab||!listen||!player)return;tab.addEventListener('click',()=>winamp.insertBefore(player,winamp.firstChild));listen.addEventListener('click',()=>listenGrid.appendChild(player))},0);
setTimeout(()=>{$('#listenModeBtn')?.addEventListener('click',()=>setSharedCustomerPlaylistVisible(true))},0);
setTimeout(()=>{const tab=$('#favoritesModeBtn'),box=$('#favoritesMode'),rows=$('#favoriteRows');if(!tab||!box)return;const renderFavorites=tracks=>{rows.innerHTML='';tracks.forEach((t,i)=>{const r=document.createElement('tr');r.innerHTML=`<td>${i+1}</td><td><b>${esc(t.name)}</b></td><td>${esc(t.size_mb)}</td><td><button class="mini-btn quick-favorite is-favorite" title="Favoriden çıkar">★</button></td>`;const star=r.querySelector('.quick-favorite');star.onclick=e=>{e.stopPropagation();safeAction(star,async()=>{const d=await post('/api/favorites/remove',{index:i});const next=d.tracks||[];renderFavorites(next);if(activePlaybackSource==='favorites'){const current=playbackTrack()?.name||'';activePlaybackTracks=next;activePlaybackQueueKey=queueKey('favorites',next);activePlaybackIndex=Math.max(0,next.findIndex(x=>x.name===current));if(shuffleEnabled)rebuildShuffleQueue(activePlaybackIndex)}toast(`☆ Favoriden çıkarıldı: ${d.removed||t.name}`)})};r.ondblclick=e=>{if(e.target.closest('.quick-favorite'))return;safeAction(r,async()=>{window.winampSource='favorites';window.winampTracks=tracks;window.winampFavoriteIndexes=new Set(tracks.map((_,n)=>n));await window.playWinampQueueIndex(i,tracks,'favorites');openWinampPlayback()})};rows.appendChild(r)})};tab.onclick=()=>safeAction(tab,async()=>{setMode('favorites');$$('.mode').forEach(x=>x.classList.remove('visible'));box.classList.add('visible');$$('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');const d=await api('/api/winamp/favorites?_='+Date.now());renderFavorites(d.tracks||[])})},0);
let customerFavoriteSyncInFlight=false;
function setQuickFavoriteState(button,favorite,customer){button.textContent=favorite?'★':'☆';button.title=favorite?'Favoriden çıkar':'Favori Listem’e ekle';button.classList.toggle('is-favorite',favorite);button.dataset.favoriteCustomer=customer||''}
function bindQuickFavorite(button,row){button.onclick=e=>{e.stopPropagation();const index=Number(row.dataset.i);safeAction(button,async()=>{if(!activeCustomer)throw new Error('Önce müşteri seç.');const d=await post('/api/winamp/favorites/toggle-customer',{customer:activeCustomer,index});setQuickFavoriteState(button,Boolean(d.favorite),activeCustomer);toast(d.favorite?'★ Favori Listem’e eklendi':'☆ Favori Listem’den çıkarıldı')})}}
setInterval(()=>{const rows=$$('#trackRows tr');rows.forEach(row=>{if(row.querySelector('.quick-favorite'))return;const cell=document.createElement('td'),button=document.createElement('button');button.className='mini-btn quick-favorite';setQuickFavoriteState(button,false,'');bindQuickFavorite(button,row);cell.appendChild(button);row.appendChild(cell)});if(!activeCustomer||customerFavoriteSyncInFlight||!rows.length)return;const buttons=rows.map(row=>row.querySelector('.quick-favorite')).filter(Boolean);if(buttons.length!==rows.length||buttons.every(button=>button.dataset.favoriteCustomer===activeCustomer))return;customerFavoriteSyncInFlight=true;api(`/api/winamp/favorites/customer-state?customer=${encodeURIComponent(activeCustomer)}&_=${Date.now()}`).then(d=>{const favorites=new Set((d.indexes||[]).map(Number));rows.forEach(row=>{const button=row.querySelector('.quick-favorite');if(button)setQuickFavoriteState(button,favorites.has(Number(row.dataset.i)),activeCustomer)})}).catch(()=>{}).finally(()=>{customerFavoriteSyncInFlight=false})},450);
setInterval(()=>{const winamp=$('#winampMode'),player=$('.player-card');if(winamp&&player&&$('#winampModeBtn').classList.contains('active')&&player.parentElement!==winamp)winamp.insertBefore(player,winamp.firstChild)},250);
setTimeout(()=>{if($('#winampPlayerStickyStyle'))return;const style=document.createElement('style');style.id='winampPlayerStickyStyle';style.textContent='#winampMode .player-card{position:sticky;top:0;z-index:70;margin:0 0 12px;background:#0b1722;box-shadow:0 14px 24px rgba(0,0,0,.38)}';document.head.appendChild(style)},0);
setTimeout(()=>{const style=document.createElement('style');style.textContent='.winamp-history-back,.winamp-history-forward{display:none!important}';document.head.appendChild(style)},0);
setTimeout(()=>{const dock=$('#winampDock');if(!dock)return;const set=visible=>dock.style.display=visible?'block':'none';$('#downloadModeBtn').addEventListener('click',()=>set(false));$('#listenModeBtn').addEventListener('click',()=>set(false));$('#winampModeBtn').addEventListener('click',()=>set(true));$('#favoritesModeBtn').addEventListener('click',()=>set(true));set(false)},0);
setTimeout(()=>{$('#favoritesModeBtn')?.addEventListener('click',()=>{const dock=$('#winampDock');if(dock)dock.style.display='none'})},0);
setTimeout(()=>{const win=$('#winampMode'),fav=$('#favoritesMode'),show=(w,f)=>{win.classList.toggle('visible',w);fav.classList.toggle('visible',f)};$('#downloadModeBtn').addEventListener('click',()=>show(false,false));$('#listenModeBtn').addEventListener('click',()=>show(false,false));$('#winampModeBtn').addEventListener('click',()=>show(true,false));$('#favoritesModeBtn').addEventListener('click',()=>show(false,true));show(false,false)},0);
setTimeout(()=>{const clearWinampActive=()=>$('#winampModeBtn')?.classList.remove('active');$('#downloadModeBtn')?.addEventListener('click',clearWinampActive);$('#listenModeBtn')?.addEventListener('click',clearWinampActive);$('#favoritesModeBtn')?.addEventListener('click',clearWinampActive)},0);
setTimeout(()=>{const player=$('.player-card');if(!player)return;const hide=()=>player.style.display='none',show=()=>player.style.display='block';$('#downloadModeBtn').addEventListener('click',hide);$('#listenModeBtn').addEventListener('click',hide);$('#favoritesModeBtn').addEventListener('click',hide);$('#winampModeBtn').addEventListener('click',show);hide()},0);

// v2.34.28 USB Satış — MP3 motorundan bağımsız kopyalama/satış ekranı.
setTimeout(()=>{
  const tab=$('#usbModeBtn'),box=$('#usbMode');
  if(!tab||!box)return;
  $('#usbAddFilesBtn').textContent='🎵 SEÇİLİ SES DOSYALARINI EKLE';
  const usbFileHeader=$('#usbBrowserFileRows')?.closest('table')?.querySelector('thead th:nth-child(2)');if(usbFileHeader)usbFileHeader.textContent='Desteklenen ses dosyaları';
  let currentTransaction=null;
  let usbSources=[],usbBrowserFolder='',usbBrowserParent='',usbSavedLocations=[],usbSavedSelected='',usbFolderSelected='',usbFileSelected='',usbBrowserFocus='folder',usbSelectedFilePaths=new Set(),usbFilter='',usbFilterTimer=null,lastUsbBrowser=null,usbBrowserRequest=0;
  const usbFilterBox=document.createElement('input');usbFilterBox.id='usbTrackFilter';usbFilterBox.type='search';usbFilterBox.placeholder='🔎 Yalnız seçili klasörde sanatçı veya şarkı ara…';usbFilterBox.autocomplete='off';usbFilterBox.style.margin='8px 0';$('#usbBrowserRoots')?.insertAdjacentElement('afterend',usbFilterBox);usbFilterBox.addEventListener('input',()=>{usbFilter=searchKey(usbFilterBox.value);clearTimeout(usbFilterTimer);usbFilterTimer=setTimeout(()=>{if(lastUsbBrowser)renderUsbBrowser(lastUsbBrowser)},80)});
  const selectedCustomers=()=>Array.from($('#usbCustomers').selectedOptions).map(x=>x.value);
  $('#usbBrowserRoots').addEventListener('contextmenu',event=>{const button=event.target.closest('.usb-saved-root');if(!button)return;event.preventDefault();safeAction(button,async()=>{const path=button.dataset.path;if(!confirm(`“${path.split(/[\\/]/).filter(Boolean).pop()||path}” müzik kısayolu kaldırılsın mı?\n\nDosyalar silinmez.`))return;usbSavedLocations=usbSavedLocations.filter(item=>item!==path);if(usbSavedSelected===path)usbSavedSelected=usbSavedLocations[0]||'';await post('/api/config',{usb_saved_locations:usbSavedLocations});renderUsbBrowser(lastUsbBrowser||{});toast('Müzik kısayolu kaldırıldı; dosyalara dokunulmadı.')})});
  const usbData=()=>({
    drive:$('#usbDrive').value,
    customers:selectedCustomers(),
    folder_name:$('#usbFolderName').value.trim()||'Muzikler',
    layout:$('#usbLayout').value,
    bitrate_kbps:Number($('#usbBitrate').value),
    shuffle:$('#usbShuffle').checked,
    unit_price:Number($('#usbUnitPrice').value||0),
    payment_method:$('#usbPayment').value
  });
  function renderTransaction(tx){
    currentTransaction=tx||null;const area=$('#usbTransaction');
    if(!tx||!['pending','submitting','uncertain','completed'].includes(tx.status)){area.classList.add('hidden-row');area.innerHTML='';return}
    const stateText={pending:'Satış onayı bekliyor',submitting:'KafePin’e gönderiliyor',uncertain:'Sonuç belirsiz — Doğrudan Satış listesini kontrol et',completed:`KafePin’e işlendi • Satış #${tx.sale_id}`}[tx.status]||tx.status;
    area.classList.remove('hidden-row');
    area.innerHTML=`<b>${esc(stateText)}</b><br>${Number(tx.copied||0)} şarkı × ${Number(tx.unit_price||0).toFixed(2)} TL = <strong>${Number(tx.total_price||0).toFixed(2)} TL</strong> • ${tx.payment_method==='CARD'?'Kart':'Nakit'}<div class="toolbar wrap">${tx.status==='pending'?'<button class="btn accent" id="usbSaleConfirm">KAFEPİN DOĞRUDAN SATIŞA EKLE</button><button class="btn" id="usbSaleCancel">SATIŞI İPTAL ET • DOSYALAR KALSIN</button><button class="btn danger" id="usbSaleDelete">AKTARILANLARI SİL + İPTAL</button>':''}</div>`;
    $('#usbSaleConfirm')?.addEventListener('click',()=>safeAction($('#usbSaleConfirm'),async()=>{if(!confirm(`${tx.total_price} TL KafePin Doğrudan Satışa eklensin mi?`))return;const d=await post('/api/usb/confirm-sale',{transaction_id:tx.id});renderTransaction(d.transaction);toast(`✓ USB satışı KafePin'e işlendi • #${d.transaction.sale_id}`)}));
    $('#usbSaleCancel')?.addEventListener('click',()=>safeAction($('#usbSaleCancel'),async()=>{if(!confirm('Satış kaydı KafePin’e gönderilmeden iptal edilsin mi? USB’deki dosyalar silinmez.'))return;const d=await post('/api/usb/cancel-sale',{transaction_id:tx.id,remove_files:false});renderTransaction(d.transaction);toast('USB aktarımı satışa eklenmeden kapatıldı.')}));
    $('#usbSaleDelete')?.addEventListener('click',()=>safeAction($('#usbSaleDelete'),async()=>{if(!confirm('Yalnız bu son işlemde aktarılan dosyalar USB’den silinsin ve ücret iptal edilsin mi?'))return;const d=await post('/api/usb/cancel-sale',{transaction_id:tx.id,remove_files:true});renderTransaction(d.transaction);toast(`✓ ${d.transaction.removed_files||0} dosya silindi • ücret KafePin’e yazılmadı`)}));
  }
  function renderPlan(p){$('#usbPlan').innerHTML=`Seçilen MP3: <b>${p.source_count}</b><br>USB’de bulunan/tekrar: <b>${p.duplicate_count}</b><br>Aktarılacak: <b>${p.copy_count}</b> • ${p.size_mb} MB<br>Hesap: ${p.copy_count} × ${Number(p.unit_price).toFixed(2)} TL<br><strong>TOPLAM: ${Number(p.total_price).toFixed(2)} TL</strong>`}
  function renderUsbSources(sources){
    usbSources=sources||[];const list=$('#usbSourceList');
    if(!usbSources.length){list.innerHTML='<div class="usb-empty">Henüz ek kaynak yok.</div>';return}
    list.innerHTML=usbSources.map(x=>`<div class="usb-source-item"><span>${x.kind==='folder'?'📁 KLASÖR':'🎵 TEK ŞARKI'} • <b>${esc(x.name)}</b><small>${esc(x.path)}</small></span><button class="mini-btn danger usb-source-remove" data-id="${esc(x.id)}" type="button">KALDIR</button></div>`).join('');
    list.querySelectorAll('.usb-source-remove').forEach(button=>button.onclick=()=>safeAction(button,async()=>{const d=await post('/api/usb/sources/remove',{id:button.dataset.id});renderUsbSources(d.sources)}));
  }
  function renderUsbBrowser(d){
    lastUsbBrowser=d||lastUsbBrowser||{};
    usbBrowserFolder=d.folder||'';usbBrowserParent=d.parent||'';
    $('#usbBrowserPath').textContent=`Klasör: ${usbBrowserFolder||'-'} • Seçili ses dosyası: ${usbSelectedFilePaths.size}`;
    $('#usbBrowserUpBtn').disabled=!usbBrowserParent;
    if(usbSavedLocations.length&&!usbSavedLocations.includes(usbSavedSelected))usbSavedSelected=usbSavedLocations[0];const saved=usbSavedLocations.map(path=>`<button class="mini-btn usb-saved-root${path===usbSavedSelected?' selected':''}" data-path="${esc(path)}" type="button">📌 ${esc(path.split(/[\\/]/).filter(Boolean).pop()||path)}</button><button class="mini-btn danger usb-remove-saved" data-path="${esc(path)}" type="button" title="Bu arşiv kısayolunu kaldır">×</button>`).join('');
    const actions=`<button class="mini-btn usb-choose-root" type="button">📂 KLASÖR SEÇ</button>${usbBrowserFolder?'<button class="mini-btn usb-save-location" type="button">📌 BU KONUMU KAYDET</button>':''}`;
    $('#usbBrowserRoots').innerHTML=saved+actions;
    $('#usbBrowserRoots').querySelectorAll('.usb-saved-root').forEach(button=>button.ondblclick=button.onclick=()=>safeAction(button,()=>selectUsbSavedRoot(button.dataset.path)));
    $('#usbBrowserRoots').querySelector('.usb-choose-root')?.addEventListener('click',()=>safeAction($('#usbBrowserRoots'),async()=>renderUsbBrowser(await api(`/api/usb/browser/choose?path=${encodeURIComponent(usbBrowserFolder||'')}&_=${Date.now()}`))));
    $('#usbBrowserRoots').querySelector('.usb-save-location')?.addEventListener('click',()=>safeAction($('#usbBrowserRoots'),async()=>{const next=[...usbSavedLocations.filter(path=>path!==usbBrowserFolder),usbBrowserFolder].slice(-12);await post('/api/config',{usb_saved_locations:next});usbSavedLocations=next;renderUsbBrowser(d);toast('📌 Müzik arşivi kısayollara eklendi.')}));
    $('#usbBrowserRoots').querySelectorAll('.usb-remove-saved').forEach(button=>button.onclick=()=>safeAction(button,async()=>{const next=usbSavedLocations.filter(path=>path!==button.dataset.path);await post('/api/config',{usb_saved_locations:next});usbSavedLocations=next;renderUsbBrowser(d)}));
    const folders=d.folders||[],allFiles=d.files||[],files=usbFilter?allFiles.filter(x=>searchKey(`${x.name||''} ${x.source_name||''}`).includes(usbFilter)):allFiles;if(!folders.some(x=>x.path===usbFolderSelected))usbFolderSelected=folders[0]?.path||'';if(!files.some(x=>x.path===usbFileSelected))usbFileSelected=files[0]?.path||'';$('#usbBrowserFolderRows').innerHTML=folders.length?folders.map(x=>`<tr class="usb-folder-row${x.path===usbFolderSelected&&usbBrowserFocus==='folder'?' selected':''}" data-path="${esc(x.path)}"><td>📁 <b>${esc(x.name)}</b></td></tr>`).join(''):'<tr><td class="usb-empty">Alt klasör yok.</td></tr>';
    $('#usbBrowserFolderRows').querySelectorAll('.usb-folder-row').forEach(row=>{row.onclick=()=>{usbBrowserFocus='folder';usbFolderSelected=row.dataset.path;renderUsbBrowser(d)};row.ondblclick=()=>browseUsbFolder(row.dataset.path)});
    $('#usbBrowserFileRows').innerHTML=files.length?files.map(x=>`<tr class="usb-file-row${x.path===usbFileSelected&&usbBrowserFocus==='file'?' selected':''}" data-path="${esc(x.path)}"><td class="usb-check-cell"><input class="usb-file-check" type="checkbox" data-path="${esc(x.path)}" ${usbSelectedFilePaths.has(x.path)?'checked':''}></td><td title="Kaynak dosya: ${esc(x.source_name||x.name)}">🎵 ${esc(x.name)} <small class="result-meta">${esc(x.format||'SES')} • ${durationFmt(x.duration_seconds||0)}</small></td><td>${x.size_mb}</td></tr>`).join(''):'<tr><td colspan="3" class="usb-empty">Bu klasörde desteklenen ses dosyası yok.</td></tr>';
    $('#usbBrowserFileRows').querySelectorAll('.usb-file-row').forEach(row=>row.onclick=event=>{if(event.target.matches('.usb-file-check'))return;usbBrowserFocus='file';usbFileSelected=row.dataset.path;renderUsbBrowser(d)});
    $('#usbBrowserFileRows').querySelectorAll('.usb-file-check').forEach(check=>check.onchange=()=>{check.checked?usbSelectedFilePaths.add(check.dataset.path):usbSelectedFilePaths.delete(check.dataset.path);$('#usbBrowserPath').textContent=`Klasör: ${usbBrowserFolder||'-'} • Seçili ses dosyası: ${usbSelectedFilePaths.size}`});
  }
  async function browseUsbFolder(path){const request=++usbBrowserRequest;const d=await api(`/api/usb/browser?path=${encodeURIComponent(path||'')}&_=${Date.now()}`);if(request!==usbBrowserRequest)return;renderUsbBrowser(d)}
  async function selectUsbSavedRoot(path){usbSavedSelected=path;usbFolderSelected='';usbFileSelected='';usbBrowserFocus='folder';await browseUsbFolder(path)}
  async function moveUsbSavedRoot(delta){if(!usbSavedLocations.length)return;let i=usbSavedLocations.indexOf(usbSavedSelected);i=(i<0?0:i)+delta;if(i<0)i=usbSavedLocations.length-1;if(i>=usbSavedLocations.length)i=0;await selectUsbSavedRoot(usbSavedLocations[i])}
  function moveUsbFolder(delta){const rows=[...$('#usbBrowserFolderRows').querySelectorAll('.usb-folder-row')];if(!rows.length)return;let i=rows.findIndex(row=>row.dataset.path===usbFolderSelected);i=Math.max(0,Math.min(rows.length-1,(i<0?0:i)+delta));usbFolderSelected=rows[i].dataset.path;rows.forEach((row,n)=>row.classList.toggle('selected',n===i));rows[i].scrollIntoView({block:'center',behavior:'instant'})}
  function moveUsbFile(delta){const rows=[...$('#usbBrowserFileRows').querySelectorAll('.usb-file-row')];if(!rows.length)return;let i=rows.findIndex(row=>row.dataset.path===usbFileSelected);i=Math.max(0,Math.min(rows.length-1,(i<0?0:i)+delta));usbFileSelected=rows[i].dataset.path;rows.forEach((row,n)=>row.classList.toggle('selected',n===i));rows[i].scrollIntoView({block:'center',behavior:'instant'})}
  function toggleUsbSelectedFile(){const row=$('#usbBrowserFileRows').querySelector(`.usb-file-row[data-path="${CSS.escape(usbFileSelected)}"]`);const check=row?.querySelector('.usb-file-check');if(!check)return;check.checked=!check.checked;check.checked?usbSelectedFilePaths.add(usbFileSelected):usbSelectedFilePaths.delete(usbFileSelected);$('#usbBrowserPath').textContent=`Klasör: ${usbBrowserFolder||'-'} • Seçili ses dosyası: ${usbSelectedFilePaths.size}`}
  async function loadUsbState(){
    const oldDrive=$('#usbDrive').value,oldSelected=new Set(selectedCustomers());
    const d=await api('/api/usb/state?_='+Date.now()),cfg=d.config||{};
    $('#usbDrive').innerHTML=(d.drives||[]).length?(d.drives||[]).map(x=>`<option value="${esc(x.drive)}">${esc(x.drive)} ${esc(x.label)} • ${x.free_gb} GB boş / ${x.total_gb} GB</option>`).join(''):'<option value="">Takılı çıkarılabilir USB bulunamadı</option>';
    if(oldDrive&&[...$('#usbDrive').options].some(x=>x.value===oldDrive))$('#usbDrive').value=oldDrive;
    $('#usbCustomers').innerHTML=(d.customers||[]).map(x=>`<option value="${esc(x)}" ${oldSelected.has(x)?'selected':''}>📁 ${esc(x)}</option>`).join('');
    if(document.activeElement!==$('#usbUnitPrice'))$('#usbUnitPrice').value=Number(cfg.usb_unit_price??10);usbSavedLocations=Array.isArray(cfg.usb_saved_locations)?cfg.usb_saved_locations:[];
    $('#usbFolderName').value=cfg.usb_folder_name||'Muzikler';$('#usbLayout').value=cfg.usb_layout||'customer';$('#usbPayment').value=cfg.usb_payment_method||'CASH';$('#usbBitrate').value=String(cfg.usb_bitrate_kbps??192);$('#usbShuffle').checked=cfg.usb_shuffle!==false;
    renderUsbSources(d.sources||[]);renderUsbBrowser(d.browser||{});if(usbSavedLocations.length)await selectUsbSavedRoot(usbSavedLocations[0]);renderTransaction(d.transaction);return d;
  }
  function showUsb(){
    $$('.mode').forEach(x=>x.classList.remove('visible'));box.classList.add('visible');$$('.tab').forEach(x=>x.classList.remove('active'));tab.classList.add('active');
    const player=$('.player-card');if(player)player.style.display='none';const dock=$('#winampDock');if(dock)dock.style.display='none';
    safeAction(tab,loadUsbState);
  }
  tab.onclick=showUsb;
  ['downloadModeBtn','listenModeBtn','winampModeBtn','favoritesModeBtn','usbFilmModeBtn','usbGameModeBtn'].forEach(id=>$('#'+id)?.addEventListener('click',()=>box.classList.remove('visible')));
  document.addEventListener('keydown',event=>{if(!box.classList.contains('visible')||event.target?.matches?.('input,textarea,select')||event.altKey||event.ctrlKey||event.metaKey)return;if(event.key==='Tab'){event.preventDefault();safeAction(null,()=>moveUsbSavedRoot(event.shiftKey?-1:1))}else if(event.key==='ArrowRight'){event.preventDefault();usbBrowserFocus='file';moveUsbFile(0)}else if(event.key==='ArrowLeft'){event.preventDefault();usbBrowserFocus='folder';moveUsbFolder(0)}else if(event.key==='ArrowDown'){event.preventDefault();usbBrowserFocus==='file'?moveUsbFile(1):moveUsbFolder(1)}else if(event.key==='ArrowUp'){event.preventDefault();usbBrowserFocus==='file'?moveUsbFile(-1):moveUsbFolder(-1)}else if(event.key==='Enter'){event.preventDefault();if(usbBrowserFocus==='file')toggleUsbSelectedFile();else if(usbFolderSelected)safeAction(null,()=>browseUsbFolder(usbFolderSelected))}else if(event.key==='Escape'){event.preventDefault();if(usbSavedSelected)safeAction(null,()=>selectUsbSavedRoot(usbSavedSelected))}},true);
  $('#usbRefreshBtn').onclick=()=>safeAction($('#usbRefreshBtn'),loadUsbState);
  $('#usbUnitPrice').onchange=()=>safeAction($('#usbUnitPrice'),()=>post('/api/config',{usb_unit_price:Number($('#usbUnitPrice').value||0)}));
  $('#usbBrowserUpBtn').onclick=()=>safeAction($('#usbBrowserUpBtn'),()=>browseUsbFolder(usbBrowserParent));
  $('#usbAddFolderBtn').onclick=()=>safeAction($('#usbAddFolderBtn'),async()=>{if(!usbBrowserFolder)throw new Error('Önce bir klasör aç.');const d=await post('/api/usb/sources/add',{paths:[usbBrowserFolder]});renderUsbSources(d.sources);toast('📁 Klasör ve altındaki MP3’ler aktarım listesine eklendi.')});
  $('#usbAddFilesBtn').onclick=()=>safeAction($('#usbAddFilesBtn'),async()=>{const paths=[...usbSelectedFilePaths];if(!paths.length)throw new Error('Önce bir veya daha fazla ses dosyası işaretle.');const d=await post('/api/usb/sources/add',{paths});renderUsbSources(d.sources);usbSelectedFilePaths.clear();await browseUsbFolder(usbBrowserFolder);toast(`🎵 ${paths.length} seçili ses dosyası aktarım listesine eklendi; seçim kutuları temizlendi.`)});
  $('#usbClearSourcesBtn').onclick=()=>safeAction($('#usbClearSourcesBtn'),async()=>{if(usbSources.length&&!confirm('Dosya gezgininden eklenen tüm klasör ve şarkılar kaldırılsın mı?'))return;const d=await post('/api/usb/sources/clear',{});renderUsbSources(d.sources);toast('Ek kaynak seçimleri temizlendi.')});
  $('#usbPreviewBtn').onclick=()=>safeAction($('#usbPreviewBtn'),async()=>{const d=await post('/api/usb/preview',usbData());renderPlan(d.plan);toast(`${d.plan.copy_count} şarkı aktarılacak • ${d.plan.duplicate_count} tekrar atlandı`)});
  $('#usbTransferBtn').onclick=()=>safeAction($('#usbTransferBtn'),async()=>{const data=usbData();if(!data.drive)throw new Error('Önce USB takıp seç.');if(!data.customers.length&&!usbSources.length)throw new Error('Müşteri klasörü seç veya dosya gezgininden klasör/MP3 ekle.');const preview=await post('/api/usb/preview',data);renderPlan(preview.plan);if(!preview.plan.copy_count){toast('USB’de olmayan yeni şarkı yok; tümü zaten mevcut.');return}if(!confirm(`${preview.plan.copy_count} şarkı USB’ye aktarılsın mı? Tahmini toplam ${preview.plan.total_price} TL.`))return;toast('USB aktarılıyor — kabloyu/USB’yi çıkarmayın…');const d=await post('/api/usb/transfer',data);renderTransaction(d.result.transaction);renderPlan({...preview.plan,copy_count:d.result.copied,total_price:Number(d.result.copied)*Number(data.unit_price)});toast(`✓ ${d.result.copied} aktarıldı • ${d.result.duplicate_count} tekrar • ${d.result.failed} hata`)});
  $('#usbFormatBtn').onclick=()=>safeAction($('#usbFormatBtn'),async()=>{const drive=$('#usbDrive').value;if(!drive)throw new Error('Biçimlendirilecek USB bulunamadı.');const letter=drive.trim().charAt(0).toUpperCase(),fs=$('#usbFilesystem').value;if(!confirm(`${drive} içindeki TÜM DOSYALAR SİLİNECEK ve ${fs} yapılacak. Devam edilsin mi?`))return;const typed=prompt(`Son güvenlik onayı: FORMAT ${letter} yazın.`,'');if(typed!==`FORMAT ${letter}`)throw new Error('Biçimlendirme iptal edildi; onay metni eşleşmedi.');toast(`${drive} biçimlendiriliyor — USB’yi çıkarmayın…`);await post('/api/usb/format',{drive,filesystem:fs,label:$('#usbLabel').value,confirmation:typed});await loadUsbState();toast(`✓ ${drive} ${fs} olarak biçimlendirildi.`)});
  $('#refreshStateBtn')?.addEventListener('click',()=>{if(tab.classList.contains('active'))safeAction(null,loadUsbState)});
},0);
