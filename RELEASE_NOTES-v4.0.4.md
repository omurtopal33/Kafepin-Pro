# KafePin Pro v4.0.4 — KÜMÜLATİF STABLE

v4.0.4, v4.0.3 TEST zincirindeki düzeltmelerin gerçek makine saha testi ve Windows Actions doğrulaması sonrasında tek STABLE pakette kilitlenmiş sürümüdür. Yeni-kafe tabanı v3.1.64 olarak kalır.

## Güncelleme ve çalışma kararlılığı

- Fail-safe update lock, aktif updater/PID ve sağlık durumunu doğrular; sahipsiz veya süresi aşmış kilit arayüzü kalıcı kapatamaz.
- `runChildTracked` hızlı child-exit yarışında callback'i bir kez tamamlar; timer güvenli başlatılır ve yalnız oluşturulduysa temizlenir.
- Güncelleme sonrası Server Manager aktivasyonu, hızlı hedefli rollback ve DB-dokunmama politikası korunur.
- Gün sonu onayı kalıcıdır; tamamlanan rapor sonraki başlangıçta tekrar istenmez.

## Yazıcı PRO ve e-Devlet

- Yazıcı PRO için 17891 ve 17893 gerçek sağlık/sürüm doğrulaması yapılır; sürüm tek kaynak olarak `yazici-pro-version.json` metadata'sından okunur.
- Yazıcı Paneli ve e-Devlet / Resmî Belgeler aynı KafePin WebView2 görünümünde çalışır; harici Chrome/Edge veya popup açılmaz.
- Resmî belge hızlı erişimleri doğrudan ilgili `turkiye.gov.tr` hizmetlerine gider; oturum bitince ayrılmış e-Devlet cookie/cache/session verisi temizlenir.
- Başarılı e-Devlet girişinde hizmet bedeli bir kez bekleyen oturuma eklenir. Windows PrintService baskıları mevcut Yazıcı PRO fiyatlandırmasıyla canlı toplamı artırır.
- Duplicate baskı olayı çift gelir oluşturmaz. İptal bir çıktı birimini düşürür, Sil bekleyen oturumu gelir oluşturmadan kaldırır, KafePin'e İşle yalnız bir kez kesinleştirir.

## EveryCafe recovery

- EveryCafe veritabanı salt-okunur kalır.
- Eksik kapanış için Manuel Aktar / Yeniden İşle idempotent çalışır; already-imported, missing source row ve bounded `SQLITE_BUSY` yolları korunur.
- Finance/session/spin davranışları değiştirilmemiştir.
