# KafePin Pro v4.0.1 — KÜMÜLATİF STABLE Kilidi

Tarih: 25.08.2026

Bu sürüm test edilip onaylanan v4.0.1 saha davranışını sabitler.

- Güncelleme ve uygulama açılışında Windows Server Manager tek sunucu yaşam döngüsü otoritesidir.
- Sağlık yalnız HTTP 200 ile değil, `/api/health` içindeki `ok:true` ve `db:true` ile doğrulanır.
- Masaüstü ilk başarısızlıkta otomatik Manager → güvenli Recovery zincirini bir kez çalıştırır; başarı yoksa yalnız o zaman manuel onarım sunulur.
- Her güncelleme KafePin çekirdek Node dosyasını kilitliyken üzerine yazmaz; EXE/DLL değişimi güvenli kurulum aşamasından geçer.
- EveryCafe erişimi salt-okunurdur. EveryCafe veritabanına yazma sorgusu yoktur.
- Finans, session/spin 45 dakika yaşam döngüsü, 20:00 işletme günü, Telegram ve PRO modül izolasyonu korunur.
- Monitor yalnız görünüm için kapanış kartını ücretsizde hemen, süresize 30 saniye, sürelide 40 saniye tutar; runtime/session/finans temizliği beklemez.
- Yeni kafe kurulum tabanı `v3.1.64` olarak sabit kalır; ilk internetli kontrolde yalnız `latest.json` üzerinden v4.0.1 STABLE’a güncellenir.
