# CODEX_HANDOFF.md — KafePin Pro Güncel Devir Notu

Bu dosya Codex / yeni sohbet / yeni geliştirici için güncel devam noktasıdır. Kod değiştirmeden önce `KAFEPIN_RULES.md` ve `AGENTS.md` mutlaka okunmalıdır.

## Güncel sürüm durumu

- **v3.1.43 = kilitli FINAL STABLE referans sürüm.** Değiştirilmez.
- **v3.1.44 = mevcut test/geliştirme update'i.** v3.1.43 üzerine gelen EveryCafe masa-otoritesi düzeltmesini içerir.
- Yeni kafe kurulum modeli: **v3.1.29 STABLE taban → doğrudan en güncel kümülatif UPDATE**.
- Ara sürümler tek tek kurulmaz.

## v3.1.43 FINAL STABLE'da bulunan ana özellikler

- EveryCafe gerçek gelir + KafePin doğrudan satış kaynak ayrımı.
- Genel Ciro = EveryCafe Gerçek Gelir + KafePin Doğrudan Satış.
- Çark maliyeti cirodan düşmez; ayrı maliyettir.
- 20:00–20:00 işletme günü; 20:00 sonrası yeni gün.
- 20:00 devir geliri ayrı gösterilebilir, ikinci kez ciroya eklenmez.
- 20:02 FULL ZIP yedek ve 20:08 sağlık raporu; cron kaçarsa catch-up.
- Finans tutarlılık kontrolü, anomali denetimi, Sistem Sağlığı, Self-Test, aylık Telegram özeti.
- EveryCafe DB yalnız read-only.
- Monitor/Telegram finans kaynakları aynı gerçek veri mantığına göre hizalanmıştır.
- İstatistiklerde tüm zamanlar çark maliyeti görünür.

## v3.1.44'te eklenen davranış

EveryCafe entegrasyonu açıkken müşteri oturumunun açık/kapalı otoritesi artık EveryCafe'dir:

- EveryCafe'de masa hesabı açık → müşteri devam eder. Ping kesilmesi / PC donması / PC restartı müşteriyi kapatmaz.
- EveryCafe'de masa hesabı kapanmış → ücretli/ücretsiz fark etmeden KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar.
- Eski 5 dakika / offline timeout yaklaşımı EveryCafe modunda müşteri kapatma nedeni değildir.
- Kapanmış eski müşteriden gelen geç ping/status/spin eski session'ı yeniden diriltmemelidir.
- Finans tutarı tahmin edilmez; EveryCafe kapanış kaydı salt-okunur kaynaktan doğrulanır.

## Çark 45 dakika yaşam döngüsü — kritik

Bu davranış daha önce sorun çıkardığı için özellikle korunmalıdır:

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
- Çark maliyeti sadece maliyet/net sonuç hesabında dikkate alınır; genel ciroyu değiştirmez.

## UI / tema koruması

- Mevcut Monitor/Admin tema, renk, kart yerleşimi ve genel görünüm kullanıcı tarafından beğenilmiş ve korunacaktır.
- Görsel yapı onaysız değiştirilmez.
- Yeni özellik mevcut tasarıma küçük ve uyumlu ekleme şeklinde yapılmalıdır.
- Özellikle `monitor.html` teması ve mevcut finans kartlarının düzeni başka düzeltmeler sırasında bozulmamalıdır.

## Günlükler

- **Sistem Sağlığı**: ilk sorun kontrol noktası.
- **Canlı Sistem Günlüğü**: anlamlı operasyonel hareketlerin ana teknik geçmişi. Masa kapanışı, EveryCafe kapanış algısı, session/spin/runtime temizliği, yeni müşteriye hazırlık, admin işlemi, yedek, gün sonu, güncelleme, alarm/anomali gibi olaylar anlaşılır şekilde kaydedilir.
- Ping/heartbeat gibi yüksek frekanslı tekrarlar log spam yapmamalıdır; sadece durum değişiklikleri anlamlı şekilde loglanır.
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
7. Her sürümde sürüm notlarını eksiksiz yaz.

## Bilinen takip konusu

- Bazı client PC'lerde ara sıra `.NET ArgumentOutOfRangeException / Parametre adı: index` hatası görülüyor. Henüz ayrıntılı stack trace incelenmedi. Bir sonraki incelemede hata penceresindeki **Ayrıntılar** çıktısı alınmalı; kesin fonksiyon belirlenmeden tahmini kod değişikliği yapılmamalıdır.

## Son kararlar

- Entegrasyon Günlüğü'ne aynı masa temizleme mesajlarını ikinci kez kopyalamak için ayrı v3.1.45 çıkarmak gereksiz bulundu.
- Anlamlı operasyonel hareketlerin Canlı Sistem Günlüğü'nde izlenmesi ana kural oldu.
- Yeni sürüm yalnız gerçek ihtiyaç/düzeltme varsa çıkarılmalı; sürüm numarası sırf tekrar kayıt için yükseltilmemelidir.
