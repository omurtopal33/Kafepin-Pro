# KafePin Pro v4.0.6 STABLE LOCK

Bu kilit, 27.08.2026 tarihinde sahada doğrulanan çalışan v4.0.6 R2 paketini bir sonraki geliştirme için değişmez referans olarak tanımlar.

## Kilitli saha paketi

- Paket: `KafePin-Pro-Update-v4.0.6-CLIENT-PERFORMANS-UNIFIED-TEST-R2.zip`
- SHA-256: `bceae3b96db509121b7232439848dd0dc9860b177ac45e6a49ea20fa039d395c`
- Boyut: `835801` byte
- Durum: saha testi başarılı; v4.0.7 geliştirmesinin değişmez başlangıç referansı

## Korunacak davranışlar

- Client Yönetim PRO ayrı sekme/servis olarak kaldırılmıştır.
- Tek istemci yönetim ekranı Client Performans PRO'dur.
- Client Performans PRO kartlarında EveryCafe oturumu, başlangıç zamanı, kalan süre, Uyandır, Yeniden Başlat ve Görev Sonlandır işlevleri korunur.
- 50/10 WebLimit ve mevcut performans telemetrisi korunur.
- CV Oluştur PRO üst menüde Yazıcı PRO'nun hemen yanında kalır.
- MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO, CV Oluştur PRO, finans, spin/session, monitor ve diğer çalışan ana özellikler kırpılmaz.
- EveryCafe veritabanı salt-okunur kalır.

## Değişiklik politikası

v4.0.7 ve sonrası bu kilitli davranışı başlangıç kabul eder. Cleanup/refactor/feature clipping adı altında çalışan özellik kaybı yapılamaz. Bu kilitli saha paketinin byte içeriği değiştirilmez; yeni geliştirme yeni sürüm numarasıyla yapılır.
