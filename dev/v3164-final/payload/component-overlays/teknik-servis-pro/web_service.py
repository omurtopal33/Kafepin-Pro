from __future__ import annotations
import base64, json, re, sqlite3, threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

ROOT=Path(__file__).resolve().parent; WEB=ROOT/'web'; DATA=ROOT/'data'; DATA.mkdir(exist_ok=True)
DB=DATA/'teknik_servis_pro.sqlite3'; PORT=17892; CORE_DIRECT_SALE_URL='http://127.0.0.1:3000/admin/product-sales/add-custom-direct'; lock=threading.Lock()
STATUSES=['Teslim alındı','İşlemde','Parça bekliyor','Hazır','Teslim edildi']
LOGO_TYPES={'png':('image/png','png'),'jpeg':('image/jpeg','jpg'),'webp':('image/webp','webp')}

def custom_logo():
 for ext in ('png','jpg','webp'):
  path=DATA/('service-logo.'+ext)
  if path.is_file():return path
 return WEB/'kafepin-logo.jpg'

def save_logo(data_url):
 match=re.fullmatch(r'data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)',str(data_url or ''),re.S)
 if not match:raise ValueError('Logo PNG, JPG veya WEBP olmalı.')
 raw=base64.b64decode(match.group(2),validate=False)
 if not raw or len(raw)>5*1024*1024:raise ValueError('Logo en fazla 5 MB olabilir.')
 mime,ext=LOGO_TYPES[match.group(1)]
 with lock:
  for old in DATA.glob('service-logo.*'):
   try:old.unlink()
   except OSError:pass
  target=DATA/('service-logo.'+ext);temp=DATA/('service-logo.'+ext+'.tmp')
  temp.write_bytes(raw);temp.replace(target)
 return {'url':'/api/logo','mime':mime}
def conn():
 c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; return c
def init():
 with conn() as c:
  c.execute('''CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY AUTOINCREMENT,ticket TEXT UNIQUE,created_at TEXT,updated_at TEXT,first_name TEXT,last_name TEXT,phone TEXT,device_type TEXT,brand_model TEXT,serial_no TEXT,fault TEXT,accessories TEXT,condition_note TEXT,work_done TEXT,price REAL DEFAULT 0,payment_status TEXT DEFAULT 'Bekliyor',status TEXT DEFAULT 'Teslim alındı',due_date TEXT,notes TEXT)''')
  for sql in ("ALTER TABLE services ADD COLUMN payment_method TEXT DEFAULT 'Nakit'", "ALTER TABLE services ADD COLUMN kafepin_sale_id INTEGER", "ALTER TABLE services ADD COLUMN kafepin_synced_at TEXT DEFAULT ''"):
   try:c.execute(sql)
   except sqlite3.OperationalError:pass
def row(x): return dict(x)
def ticket(i): return 'TS-'+datetime.now().strftime('%Y%m%d')+'-'+str(i).zfill(4)
def list_services(q='',status=''):
 sql='SELECT * FROM services WHERE 1=1'; args=[]
 if q: sql+=' AND (first_name||" "||last_name LIKE ? OR phone LIKE ? OR ticket LIKE ? OR brand_model LIKE ?)';args += ['%'+q+'%']*4
 if status: sql+=' AND status=?';args.append(status)
 sql+=' ORDER BY CASE status WHEN "Teslim alındı" THEN 0 WHEN "İşlemde" THEN 1 WHEN "Parça bekliyor" THEN 2 WHEN "Hazır" THEN 3 ELSE 4 END, id DESC'
 with conn() as c:return [row(x) for x in c.execute(sql,args)]
def payment_method(value):return 'CARD' if str(value or '').strip().upper() in ('KART','CARD') else 'CASH'
def send_direct_sale(service):
 amount=round(float(service['price'] or 0),2)
 if amount<=0:raise ValueError('Tahsil edilmiş servis için fiyat 0’dan büyük olmalı.')
 customer=' '.join(x for x in [str(service['first_name'] or '').strip(),str(service['last_name'] or '').strip()] if x)
 device=str(service['brand_model'] or service['device_type'] or '').strip()
 name=f"Teknik Servis • {service['ticket']}"
 if customer:name+=f" • {customer}"
 if device:name+=f" • {device}"
 raw=json.dumps({'name':name[:100],'unitPrice':amount,'quantity':1,'paymentMethod':payment_method(service['payment_method'])}).encode('utf-8')
 try:
  with urlopen(Request(CORE_DIRECT_SALE_URL,data=raw,headers={'Content-Type':'application/json'},method='POST'),timeout=12) as response:result=json.loads(response.read().decode('utf-8'))
 except Exception as exc:raise RuntimeError('KafePin doğrudan satışa ulaşılamadı: '+str(exc))
 if not result.get('ok') or not result.get('id'):raise RuntimeError('KafePin doğrudan satış hatası: '+str(result.get('error') or 'Bilinmeyen hata'))
 return int(result['id'])
def save(data):
 fields=['first_name','last_name','phone','device_type','brand_model','serial_no','fault','accessories','condition_note','work_done','price','payment_status','payment_method','status','due_date','notes']; now=datetime.now().isoformat(timespec='seconds'); values=[str(data.get(k,'')).strip() for k in fields]; values[10]=float(data.get('price') or 0);values[11]='Ödendi' if values[11]=='Ödendi' else 'Bekliyor';values[12]='Kart' if payment_method(values[12])=='CARD' else 'Nakit'
 with conn() as c:
  if data.get('id'):
   existing=row(c.execute('SELECT * FROM services WHERE id=?',(int(data['id']),)).fetchone())
   if not existing:raise ValueError('Servis kaydı bulunamadı.')
   if existing.get('kafepin_sale_id') and (values[10]!=float(existing['price'] or 0) or values[11]!='Ödendi' or values[12]!=str(existing['payment_method'] or 'Nakit')):raise ValueError('Bu tahsilat KafePin doğrudan satışa aktarıldı; fiyat veya ödeme bilgisi değiştirilemez.')
   c.execute('UPDATE services SET '+','.join(k+'=?' for k in fields)+',updated_at=? WHERE id=?',values+[now,int(data['id'])]); sid=int(data['id'])
  else:
   cur=c.execute('INSERT INTO services(created_at,updated_at,'+','.join(fields)+') VALUES ('+','.join('?'*(len(fields)+2))+')',[now,now]+values);sid=cur.lastrowid;c.execute('UPDATE services SET ticket=? WHERE id=?',(ticket(sid),sid))
  service=row(c.execute('SELECT * FROM services WHERE id=?',(sid,)).fetchone())
 if service['payment_status']=='Ödendi' and not service.get('kafepin_sale_id'):
  sale_id=send_direct_sale(service)
  with conn() as c:c.execute('UPDATE services SET kafepin_sale_id=?,kafepin_synced_at=?,updated_at=? WHERE id=?',(sale_id,now,now,sid));service=row(c.execute('SELECT * FROM services WHERE id=?',(sid,)).fetchone())
 return service
class H(SimpleHTTPRequestHandler):
 def log_message(self,*x):pass
 def sendj(self,x,code=200):
  b=json.dumps(x,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(b)
 def do_GET(self):
  u=urlparse(self.path); q=parse_qs(u.query)
  try:
   if u.path=='/api/health':return self.sendj({'ok':True,'app':'Teknik Servis PRO','isolation':'separate-loopback-service'})
   if u.path=='/api/settings':return self.sendj({'ok':True,'logo_url':'/api/logo'})
   if u.path=='/api/logo':
    path=custom_logo();content=path.read_bytes();mime='image/png' if path.suffix.lower()=='.png' else 'image/webp' if path.suffix.lower()=='.webp' else 'image/jpeg'
    self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(content)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(content);return
   if u.path=='/api/services':return self.sendj({'ok':True,'services':list_services(q.get('q',[''])[0],q.get('status',[''])[0]),'statuses':STATUSES})
   if u.path=='/api/summary':
    items=list_services();return self.sendj({'ok':True,'open':sum(x['status']!='Teslim edildi' for x in items),'ready':sum(x['status']=='Hazır' for x in items),'revenue':sum(float(x['price'] or 0) for x in items if x['payment_status']=='Ödendi')})
   if u.path=='/api/service':
    with conn() as c:r=c.execute('SELECT * FROM services WHERE id=?',(int(q['id'][0]),)).fetchone();return self.sendj({'ok':True,'service':row(r) if r else None})
   name='index.html' if u.path in ('/','/index.html') else u.path.lstrip('/')
   path=(WEB/name).resolve()
   if WEB not in path.parents and path != WEB: raise ValueError('Geçersiz dosya yolu.')
   if not path.is_file(): return self.sendj({'ok':False,'error':'Bulunamadı'},404)
   content=path.read_bytes(); mime='text/html; charset=utf-8' if path.suffix=='.html' else 'text/css; charset=utf-8' if path.suffix=='.css' else 'application/javascript; charset=utf-8'
   self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(content)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(content);return
  except Exception as e:self.sendj({'ok':False,'error':str(e)},500)
 def do_POST(self):
  try:
   n=int(self.headers.get('Content-Length','0'));data=json.loads(self.rfile.read(n) or b'{}')
   if self.path=='/api/services/save':return self.sendj({'ok':True,'service':save(data)})
   if self.path=='/api/settings/logo':return self.sendj({'ok':True,'logo':save_logo(data.get('data_url'))})
   if self.path=='/api/services/delete':
    with conn() as c:c.execute('DELETE FROM services WHERE id=?',(int(data['id']),));return self.sendj({'ok':True})
   self.sendj({'ok':False,'error':'Bulunamadı'},404)
  except Exception as e:self.sendj({'ok':False,'error':str(e)},500)
if __name__=='__main__':init();ThreadingHTTPServer(('127.0.0.1',PORT),H).serve_forever()
