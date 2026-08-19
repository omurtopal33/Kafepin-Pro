# CODEX_HANDOFF.md — KafePin Pro Güncel Devir Notu

Bu dosya Codex / yeni sohbet / yeni geliştirici için güncel devam noktasıdır. Kod değiştirmeden önce `KAFEPIN_RULES.md` ve `AGENTS.md` mutlaka okunmalıdır.

## Güncel sürüm durumu

- **v3.1.45 = kilitli FINAL STABLE referans sürüm.** Yerinde değiştirilmez.
- **v3.1.44 = v3.1.45'e temel olan sahada/testte doğrulanmış EveryCafe oturum-otoritesi sürümü.**
- Bundan sonraki geliştirmeler **v3.1.46+** olarak devam eder.
- Yeni kafe kurulum modeli: **v3.1.29 STABLE taban → doğrudan en güncel kümülatif STABLE UPDATE**.
- Ara sürümler tek tek kurulmaz.

## v3.1.45 FINAL STABLE özeti

- v3.1.44'te test edilen EveryCafe masa/oturum otoritesi davranışı aynen korunur.
- EveryCafe entegrasyonu açıkken müşteri oturumunun açık/kapalı kararında tek otorite EveryCafe'dir; ping yalnız PC bağlantı bilgisidir.
- EveryCafe hesabı açıkken ping kaybı, PC donması veya restart müşteriyi kapatmaz.
- EveryCafe hesabı kapanınca ücretli/ücretsiz fark etmeden KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar; eski istemcinin geç ping/status/spin isteği eski session'ı diriltemez.
- v3.1.43'teki finans tutarlılığı, 20:00 işletme günü, FULL ZIP yedek, sağlık raporu, anomali denetimi, Self-Test, veri kaynağı rozetleri ve aylık Telegram özeti korunur.
- Yönetim panelindeki **KafePin Pro Sürüm Notları** ekranına v3.1.39–v3.1.45 arasındaki eksik ayrıntılı sürüm kartları eklendi.
- Gelecekte statik sürüm kartı unutulsa bile gerçek update-status/latest notes bilgisi geldiğinde oluşturulan geçici sürüm kartı güncellenir; gerçek not varken “ayrıntılı not kaydı eklenmemiş” mesajı kalıcı kalmaz.
- `server.js` ana işleyişi, Monitor/Admin tema-yapısı, finans formülleri, 20:00 sınırı ve 45 dakika çark mantığı bu düzeltme için değiştirilmedi.

## Çark 45 dakika yaşam döngüsü — kritik ve değişmez

1. Yeni müşteri KafePin çark sayfasını hiç açmadıysa sayaç **başlamaz**.
2. İlk gerçek sayfa açılışında `45:00` başlar; anında spin yoktur.
3. Sayaç başladıktan sonra pencere kapatılsa bile gerçek zaman ilerler; süre dondurulmaz.
4. Pencere yeniden açıldığında kalan gerçek süre görünür; 45 dakika dolmuşsa spin hazırdır.
5. Başarılı spin sonrası yeniden `45:00` başlar.
6. EveryCafe müşteri hesabı kapanınca eski müşteri sayaç/runtime/hak durumu temizlenir.
7. Yeni müşteri eski süreyi veya spin haklarını devralmaz; kendi sayfasını ilk açana kadar sayaç başlamaz.
8. 5 spin hakkı aktif müşteri/session bazındadır.
9. Yalnız Admin Acil Hazır / force-ready beklemeyi atlayabilir.
10. EveryCafe ücretsiz/hediye süreleri çark sayacını etkilemez.

Sabit çark maliyetleri:
- Normal 30 dk = 25 TL
- Normal 60 dk = 50 TL
- VIP 30 dk = 35 TL
- VIP 60 dk = 70 TL
- İçecek/atıştırmalık/anahtarlık = 20 TL

## Finans ve veri güvenliği

- EveryCafe veritabanına hiçbir koşulda yazma yoktur.
- Tüm EveryCafe bağlantıları `sqlite3.OPEN_READONLY` olmalıdır.
- KafePin kendi session/spin/audit/ayar/muhasebe kayıtlarını kendi DB'sinde tutar.
- EveryCafe gelirinin bileşenleri aynı geliri ikinci kez genel ciroya eklememelidir.
- EveryCafe Gerçek Gelir + KafePin Doğrudan = Genel Ciro.
- Çark maliyeti yalnız maliyet/net sonuç hesabında dikkate alınır; genel ciroyu değiştirmez.

## UI / tema koruması

- Mevcut Monitor/Admin tema, renk, kart yerleşimi ve genel görünüm korunur.
- Görsel yapı onaysız değiştirilmez.
- Yeni özellik mevcut tasarıma küçük ve uyumlu ekleme şeklinde yapılmalıdır.
- Özellikle `monitor.html` teması ve mevcut finans kartlarının düzeni başka düzeltmeler sırasında bozulmamalıdır.

## Günlükler

- **Sistem Sağlığı**: ilk sorun kontrol noktası.
- **Canlı Sistem Günlüğü**: anlamlı operasyonel hareketlerin ana teknik geçmişi. Masa kapanışı, EveryCafe kapanış algısı, session/spin/runtime temizliği, yeni müşteriye hazırlık, admin işlemi, yedek, gün sonu, güncelleme, alarm/anomali gibi olaylar anlaşılır şekilde kaydedilir.
- Ping/heartbeat gibi yüksek frekanslı tekrarlar log spam yapmamalıdır; yalnız durum değişiklikleri anlamlı şekilde loglanır.
- **Entegrasyon Günlüğü**: finans/EveryCafe audit ayrıntıları için ayrı tutulabilir; Sistem Günlüğü ile gereksiz tekrar oluşturulmaz.

## Çalışma şekli / kullanıcı beklentisi

Kullanıcı çalışan ana yapının korunmasını istiyor. Özellikle `server.js` ana akışı ve Monitor/Admin teması onaysız değişmemelidir.

Yeni bir istek geldiğinde:
1. Önce mevcut kod ve kurallarla etkisini değerlendir.
2. Ne değişeceğini ve riski kullanıcıya açıkla.
3. Kullanıcı onay verirse hedefli kod değişikliği yap.
4. İlgisiz çalışan kodlara dokunma.
5. Paketlemeden önce test et ve sonucu kullanıcıya açıkla.
6. Kullanıcı paketleme istediyse yeni kümülatif sürüm numarasıyla paketle.
7. Her sürümde ayrıntılı sürüm notlarını eksiksiz yaz ve Yönetim panelindeki Sürüm Notları ekranında görünürlüğünü test et.

## Bilinen takip konusu

- Bazı client PC'lerde ara sıra `.NET ArgumentOutOfRangeException / Parametre adı: index` hatası görülüyor. Henüz ayrıntılı stack trace incelenmedi. Bir sonraki incelemede hata penceresindeki **Ayrıntılar** çıktısı alınmalı; kesin fonksiyon belirlenmeden tahmini kod değişikliği yapılmamalıdır.

## Son kararlar

- v3.1.45 FINAL STABLE kilitlidir; bundan sonra v3.1.46+ üzerinden devam edilir.
- Entegrasyon Günlüğü ile Canlı Sistem Günlüğü gereksiz şekilde aynı kayıtlarla doldurulmaz.
- Anlamlı operasyonel hareketlerin Canlı Sistem Günlüğü'nde izlenmesi ana kuraldır.
- Yeni sürüm yalnız gerçek ihtiyaç/düzeltme varsa çıkarılır; sürüm notu ve paket testleri zorunludur.
