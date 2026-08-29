# KafePin Pro Güncelleme Merkezi

## Güncel sürüm düzeni

- **v4.0.11 STABLE/FINAL:** Güncel saha sürümüdür; v4.0.10 STABLE tam tabanı korunarak v4.0.11 R4 WebLimit ve TV monitör modu exact olarak kilitlenmiştir.
- **Yeni kafe dağıtımı değişmez:** `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` çevrimdışı kurulum tabanıdır. Her STABLE sürüm için yeni bir yeni-kafe ZIP'i üretilmez.
- Yeni kafe v3.1.64 FINAL ile kurulur; internet varsa yalnız `latest.json` içindeki daha yeni STABLE sürümü tek adımda alır.
- Ara sürümlerin tek tek kurulması gerekmez.
- TEST paketleri STABLE dağıtım kaynağı değildir; `latest.json` yalnız güncel STABLE güncellemeyi gösterir.

## Yeni Kafe kurulumu

1. `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` içindeki `KURULUMU_BASLAT.cmd` çalıştırılır.
2. Kurucu internet olmasa da v3.1.64 FINAL tabanını kurabilir.
3. İnternet varsa `latest.json` kontrol edilir; daha yeni STABLE varsa doğrudan güncel kümülatif STABLE'a yükseltilir.
4. Ara update sürümleri kurulmaz.

PRO klasör düzeni korunur:

- MP3 Bot PRO: `C:\KafePinPro\MP3BotPRO`
- Yazıcı PRO: `C:\KafePinPro\YaziciPRO`
- Teknik Servis PRO: `C:\KafePinPro\TeknikServisPRO`
- Client Performans PRO: `C:\KafePinPro\ClientPerformansPRO`

## v4.0.11 STABLE kilitleri

- Client Performans PRO WebLimit: tek masa ve tüm masalar ayarları ayrıdır; offline masaların toplu ayarı reconnect sırasında yeniden uygulanır; `Kapat` tercihi kalıcıdır.
- Monitor TV modu yalnız `monitor.html?tv=1` ile açılır; aynı anda 3 online masa gösterilir, ping/Mbps/süre/ücret/ödül bilgileri korunur ve sayfalar 9 saniyede değişir. Normal monitor görünümü değişmez.
- v4.0.10 STABLE ZIP’indeki tüm gerçek dosyalar korunmuştur; v4.0.11 R4 overlay’leri byte düzeyinde doğrulanmıştır.

- Önceki onaylı kümülatif düzeltmeler korunur.
- Yönetim merkezi; Kafe & Çark, EveryCafe, Anlık Finans ve Kasa & Muhasebe içinde son açık paneli ile kaydırma konumunu saklar. Başka sekmeden dönünce kullanıcı aynı yerde kalır.
- Monitor, TV / Chrome %175 ölçekte kart metnini okunur büyüklükte tutar; içerik taşarsa yalnız ilgili kartın metni otomatik sığar.
- EveryCafe kapanışında ücretsiz masa monitörden hemen kalkar; süresiz son gerçek tutar kartı 30 saniye, süreli son gerçek tutar kartı 40 saniye kalır. Bu yalnız görünüm bekletmesidir; session/runtime/finans temizliği hemen sürer.
- MP3 Bot PRO Winamp klasör gezgini, kalıcı klasör seçimi, hızlı arama, favoriler ve metadata başlıkları korunur.
- USB MP3 / Film / Oyun sol seçim–sağ hesap listesi, seçili boyut/fiyat, USB boş alan ve güvenli aktarım hazırlığı korunur.
- PRO modülleri kurulu seçimleri mevcut kafelerde aynen korur; yeni kafe v3.1.64 tabanından güncellenir.
- Güncelleme sırasında masaüstü EXE/DLL dosyaları önce uygulama kapatılıp dosya kilidi doğrulanmadan değiştirilmez; EBUSY/EPERM yarım kurulum bırakmaz. Hedefli rollback için gerçek disk I/O watchdog 90 saniyedir.
- Update paketi `database.db`, `database.db-wal` ve `database.db-shm` içermez; update sırasında DB'ye dokunulmaz. Çift update/backup yarışı engellenir.
- Client Performans bağlantı hızı göstergesi, 1000 Mbps altı uyarı ve 17896 portunda tek-instance koruması; EveryCafe `SQLITE_BUSY` bounded retry ve Manager → Recovery sağlık doğrulaması korunur.
- Güncelleme veya açılış sonrasında 3000/DB sağlığı gelmezse masaüstü önce Windows Server Manager, ardından güvenli recovery akışını otomatik çalıştırır; yalnız bu iki doğrulanmış adım başarısızsa manuel onarım gösterilir.
- Çarktan çıkan **hediye süre**, masa kapanışında onaylandıktan sonra EveryCafe bilet geliriyle tekil eşleşirse `Promosyon / Çark Hediyesi` olarak sınıflandırılır ve normal gelire eklenmez.
- Eşleşmeyen EveryCafe bilet hareketi gerçek satış olarak normal gelirde kalır.
- İçecek/atıştırmalık ödülleri hediye-süre bilet eşleştirmesine girmez.

## Güvenlik ve ana yapı

- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe'ye yazma yapılmaz.
- KafePin session, spin, 45 dakika yaşam döngüsü, 20:00 işletme günü, Telegram ve ana finans davranışları onaysız değiştirilmez.
- Monitor/Admin tema ve kart yapısı onaysız değiştirilmez.
- Aynı EveryCafe hareketi ikinci kez gelir veya promosyon olarak kaydedilmez.

## Depo düzeni

Korunacak temel dağıtımlar:

- `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` — yeni kafe çevrimdışı tabanı.
- `KafePin-Client-v3.1.64.zip` — eşleşen Client dağıtımı.
- Güncel `KafePin-Pro-Update-v4.0.11-STABLE.zip` — aktif STABLE update.

Eski ara sunucu update ZIP/SHA ve eski ara release notları, v4.0.6 ZIP GitHub'a başarıyla yerleşip `latest.json` doğrulandıktan sonra arşivlenebilir. Yeni-kafe FINAL v3.1.64 ve gerekli Client/kurulum referansları korunur.

Ayrıntılı değişmez saha kilidi: `STABLE_LOCK-v4.0.11.md`.
