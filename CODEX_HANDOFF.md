# CODEX_HANDOFF.md — KafePin Pro Güncel Devir Notu

Bu dosya Codex / yeni sohbet / yeni geliştirici için güncel devam noktasıdır. Kod değiştirmeden önce `KAFEPIN_RULES.md` ve `AGENTS.md` mutlaka okunmalıdır.

## Güncel sürüm durumu

- **v3.1.45 = kilitli FINAL STABLE referans sürüm.** Yerinde değiştirilmez.
- **v3.1.46 = güncel TEST / saha doğrulama adayı.** v3.1.45 çekirdeğini koruyup EveryCafe çark-hazır masa bildirimi ekler.
- GitHub'da `KafePin-Pro-Update-v3.1.46.zip` mevcuttur ve `latest.json` şu anda test için v3.1.46'yı gösterir.
- v3.1.46 saha testi tamamlanıp kullanıcı ayrıca onaylamadan FINAL STABLE sayılmaz; güvenli referans v3.1.45'tir.
- Yeni kafe kurulum modeli: **v3.1.29 STABLE taban → doğrudan en güncel onaylı kümülatif UPDATE**.
- Ara sürümler tek tek kurulmaz.

## v3.1.46 — EveryCafe çark-hazır masa bildirimi

Kullanıcı tarafından gerçek MASA-20 üzerinde EveryCafe Messenger mesaj gönderimi başarıyla doğrulandı. KafePin entegrasyonu bu sahada doğrulanmış mesaj yolunu kullanır.

Davranış kuralları:

1. Yeni müşteri KafePin çark sayfasını hiç açmadıysa sayaç **başlamaz** ve bildirim gönderilmez.
2. İlk gerçek çark sayfası açılışında sabit `45:00` başlar; anında spin veya mesaj yoktur.
3. Sayfa/pencere kapansa bile EveryCafe müşteri oturumu açık kaldığı sürece gerçek zaman ilerler.
4. 45 dakika dolunca yalnız ilgili EveryCafe masasına bir kez **“🎁 Çark hakkınız hazır! Çarkınızı çevirebilirsiniz.”** mesajı gönderilir.
5. Başarılı spin sonrası yeni 45 dakika başlar; yeni döngü dolunca yine yalnız bir kez mesaj gider.
6. EveryCafe oturumu kapanınca eski müşterinin sayaç/runtime/bildirim-gönderildi durumu KafePin tarafında temizlenir.
7. Yeni müşteri eski müşteriden süre, hazır bildirim veya spin hakkı devralmaz; kendi sayfasını ilk açana kadar sayaç başlamaz.
8. Aynı hazır döngü için mesaj spam yapılmaz.
9. Mesaj anında EveryCafe Client geçici olarak uygun değilse mesaj gönderilmiş sayılmaz; uygun olduğunda yeniden denenebilir.
10. Başarılı gönderim Canlı Sistem Günlüğü'ne örneğin `🎁 Çark bildirimi gönderildi • Masa 20 • 192.168.1.120` olarak yazılır. Anlamlı gönderim hataları da spam yapmadan loglanır.

Teknik mesaj yolu:

- EveryCafe DB'ye mesaj INSERT/UPDATE yapılmaz.
- Hedef masa IP'si / gerekli EveryCafe kaynak bilgileri yalnız `sqlite3.OPEN_READONLY` ile okunur.
- Gerçek ecmdata incelemesinde MASA-20 hedefi `192.168.1.120` ve EveryCafe Client Messenger hedef portu `45456` olarak doğrulandı.
- Kullanıcının manuel PowerShell testi gerçek MASA-20'de başarılı oldu.
- UDP gönderiminde ayrı teslim/okundu ACK'i olmadığı için Canlı Sistem Günlüğündeki “gönderildi” kaydı işletim sisteminin paketi hedef IP/porta başarıyla gönderime aldığını ifade eder; client ekranında okunma garantisi anlamına gelmez.

## v3.1.46 saha testi

Öncelikli saha kontrolü:

1. Test masasının aktif EveryCafe müşteri oturumu olmalı.
2. Müşteri çark sayfasını gerçekten açmalı; sayfa hiç açılmadıysa otomatik mesaj beklenmemeli.
3. Normal testte 45 dakikanın dolması gözlenmeli; hızlı kontrollü testte yalnız mevcut Admin Acil Hazır mekanizması kullanılabilir ancak sayfa-açıldı koşulu korunmalıdır.
4. Süre hazır olduğunda yalnız hedef masaya mesaj gelmeli.
5. Canlı Sistem Günlüğü'nde doğru masa/IP ile tek gönderim kaydı görülmeli.
6. Aynı döngüde ikinci/üçüncü tekrar mesajı gelmemeli.
7. Spin sonrası yeni 45 dakika başlamalı ve yeni döngü dolunca yeni bir bildirim hakkı oluşmalı.
8. EveryCafe oturumu kapatılıp yeni müşteri açıldığında eski bildirim/süre durumu taşınmamalı.
9. Finans, 20:00 işletme günü, EveryCafe oturum otoritesi, yedek ve Monitor/Admin görünümü değişmemeli.
10. Test sonucu başarılıysa ancak kullanıcı onayıyla v3.1.46 FINAL STABLE olarak kilitlenebilir.

## v3.1.45 FINAL STABLE özeti

- v3.1.44'te test edilen EveryCafe masa/oturum otoritesi davranışı aynen korunur.
- EveryCafe entegrasyonu açıkken müşteri oturumunun açık/kapalı kararında tek otorite EveryCafe'dir; ping yalnız PC bağlantı bilgisidir.
- EveryCafe hesabı açıkken ping kaybı, PC donması veya restart müşteriyi kapatmaz.
- EveryCafe hesabı kapanınca ücretli/ücretsiz fark etmeden KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar; eski istemcinin geç ping/status/spin isteği eski session'ı diriltemez.
- v3.1.43'teki finans tutarlılığı, 20:00 işletme günü, FULL ZIP yedek, sağlık raporu, anomali denetimi, Self-Test, veri kaynağı rozetleri ve aylık Telegram özeti korunur.
- Yönetim panelindeki **KafePin Pro Sürüm Notları** ekranına v3.1.39–v3.1.45 arasındaki eksik ayrıntılı sürüm kartları eklendi.
- Gelecekte statik sürüm kartı unutulsa bile gerçek update-status/latest notes bilgisi geldiğinde oluşturulan geçici sürüm kartı güncellenir.

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
- KafePin kendi session/spin/audit/ayar/muhasebe/bildirim durumlarını kendi DB'sinde tutar.
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
- **Canlı Sistem Günlüğü**: anlamlı operasyonel hareketlerin ana teknik geçmişi. Masa kapanışı, EveryCafe kapanış algısı, session/spin/runtime temizliği, yeni müşteriye hazırlık, çark-hazır bildirim gönderimi, admin işlemi, yedek, gün sonu, güncelleme, alarm/anomali gibi olaylar anlaşılır şekilde kaydedilir.
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

## Codex için ilk görev

Önce `AGENTS.md`, `KAFEPIN_RULES.md` ve bu `CODEX_HANDOFF.md` dosyasını tamamen oku. Ardından GitHub'daki v3.1.46 paketini incele. **Kod değiştirme.** Kullanıcıya mevcut durumu, v3.1.46 saha test adımlarını ve gördüğün riskleri özetle. Kullanıcı onayı olmadan `server.js`, finans, spin, EveryCafe, 20:00 veya Monitor/Admin yapısına müdahale etme.
