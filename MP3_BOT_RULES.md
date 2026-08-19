# KafePin MP3 Bot PRO – Değişmez İzolasyon Kuralları

Bu dosya KafePin MP3 Bot PRO entegrasyonu ve sonraki MP3 geliştirmeleri için değişmez sınırları tanımlar.

## 1. Ana ilke: KafePin ve MP3 Bot birbirine karışmaz

- **KafePin Pro çekirdeği ile KafePin MP3 Bot PRO teknik olarak iki ayrı sistemdir.**
- Kullanıcı MP3 Bot'u KafePin masaüstü penceresindeki `🎵 KafePin MP3 Bot PRO` sekmesinden görüp kullanabilir; bu yalnız kullanıcı arayüzü entegrasyonudur.
- MP3 Bot'un çalışması, durması veya hata vermesi KafePin'in masa, session, finans, spin, EveryCafe, gün sonu, yedek, Telegram veya sunucu yaşam döngüsünü etkileyemez.
- KafePin'in çalışması veya yeniden başlaması da aktif MP3 işlerinin veri bütünlüğünü bozacak ortak runtime durumuna bağlı olmamalıdır.

## 2. Dosya ve proses ayrımı

- KafePin ana kurulum kökü: `C:\KafePin\`.
- MP3 Bot ayrı kökte çalışır: `C:\KafePinMp3BotPRO\`.
- MP3 Bot'a ait Python ortamı, yt-dlp, FFmpeg, config, log, cache ve geçici dosyalar MP3 Bot kökünde veya MP3 Bot'a özel kullanıcı veri alanında tutulur.
- MP3 Bot dosyaları `C:\KafePin\` içine karıştırılmaz.
- MP3 Bot kendi proses/servis yaşam döngüsüne sahiptir; KafePin Node prosesine Python/yt-dlp/FFmpeg kodu gömülmez.

## 3. Veritabanı ve çekirdek erişim yasağı

- **MP3 Bot KafePin veritabanını ASLA açmaz, okumaz veya yazmaz.**
- MP3 Bot `server.js`, session tabloları, spin kayıtları, finans kayıtları, EveryCafe bağlantıları, gün sonu kayıtları, Telegram ayarları veya KafePin runtime haritalarına erişmez.
- KafePin de MP3 Bot'un müşteri müzik klasörlerine, MP3 config'ine, indirme kuyruğuna veya oynatıcı durumuna iş mantığı amacıyla müdahale etmez.
- İki sistem arasında ortak SQLite DB, ortak session, ortak RAM state veya ortak lock kullanılmaz.

## 4. İzin verilen tek entegrasyon yüzeyi

- MP3 Bot yerel loopback servis olarak çalışabilir; varsayılan hedef `127.0.0.1:17890` gibi yalnız yerel makineden erişilebilen bir adrestir.
- KafePin masaüstü kabuğundaki MP3 sekmesi bu yerel paneli aynı WebView2 penceresinde gösterebilir.
- KafePin, MP3 Bot çalışmıyorsa yalnız MP3 Bot başlatıcısını tetikleyebilir ve panel hazır olunca yerel URL'ye gidebilir.
- KafePin sunucusu MP3 Bot API'sini proxy'lemek, MP3 işlerini yürütmek veya MP3 verisini kendi DB'sine taşımak zorunda değildir.
- MP3 entegrasyonu için `server.js` ana işleyişine bağımlılık eklenmez.

## 5. UI kuralı

- MP3 web paneli KafePin'in mevcut koyu renk paleti ve görsel dilini kullanabilir.
- Bu uyum MP3 panelinin kendi CSS'i ile yapılır; KafePin Monitor/Admin/Yönetim tema dosyaları sırf MP3 için yeniden tasarlanmaz.
- KafePin tarafındaki değişiklik yalnız gerekli üst sekme/navigasyon eklemesi kadar küçük tutulur.

## 6. MP3 fonksiyonel referansı

- Web sürümüne taşınacak fonksiyonel referans **KafePin MP3 Bot PRO v2.26**'dır.
- İndirme Modu ve Dinleme Modu korunur.
- YouTube arama, çift tıkla listeye ekleme, Direct/ByClick, 128/320 kbps, canlı EQ, EQ önizleme, müşteri klasörleri, -14 LUFS / -1.5 dBTP 2-pass normalizasyon, 403 fallback zinciri ve Dinleme Modu oynatıcı özellikleri regresyona uğratılmaz.
- Kalıcı indirme geçmişi tutulmaz. Aynı `Sanatçı + Şarkı` mevcut indirme listesinde ikinci kez eklenmez; ayrıca hedef müşteri klasöründe aynı `Sanatçı + Şarkı` MP3 zaten varsa tekrar indirilmez.
- Web arama kutusu normal YouTube araması gibi davranır: kullanıcının yazdığı sorgu anlamı değiştirilmeden YouTube aramasına gönderilir ve kullanıcıya arama sonuçları gösterilir.
- Otomatik liste çözümleme/indirme seçiminde yanlış parçaya sessizce geçilmez; `Sanatçı + Şarkı` birlikte yüksek güvenle eşleşmeli, kullanıcı özellikle istemediyse `live`, `remix`, `cover`, `karaoke` gibi farklı sürümler otomatik seçilmemelidir.
- Bir YouTube sonucu elle seçildiyse seçilen videonun URL'si korunur; sistem onu sonradan benzer adlı başka videoyla değiştirmez.
- Sanatçı listeleri/playlistlerinde seçilen sanatçıya ait olmadığı doğrulanan parçalar sanatçı listesi gibi sunulmaz.

## 7. Sürüm ve test disiplini

- **KafePin v3.1.45 kilitli FINAL STABLE referansıdır; MP3 çalışması nedeniyle yerinde değiştirilmez.**
- KafePin tarafında entegrasyon gerekiyorsa yeni kümülatif test sürümünde, minimum navigasyon değişikliği olarak yapılır.
- MP3 Bot kendi sürüm çizgisini ayrı tutabilir ve MP3 motoru bağımsız güncellenebilir.
- Her MP3 entegrasyon testinde özellikle şu izolasyon kontrolleri yapılır:
  - MP3 Bot kapalıyken KafePin normal çalışıyor mu?
  - MP3 Bot hata verdiğinde KafePin etkilenmiyor mu?
  - KafePin yeniden başladığında MP3 dosyaları/config bozulmuyor mu?
  - MP3 kodunda KafePin DB/server.js erişimi bulunmuyor mu?
  - MP3 servisi yalnız loopback üzerinde mi dinliyor?
  - KafePin çekirdek finans/spin/EveryCafe/gün sonu dosyalarında gereksiz değişiklik var mı?

## 8. Değişiklik onayı

- Bu izolasyon sınırını aşacak her fikir kodlanmadan önce kullanıcıya açıkça anlatılır ve ayrıca onay alınır.
- Kolaylık amacıyla bile MP3 motoru KafePin çekirdeğine gömülmez.
