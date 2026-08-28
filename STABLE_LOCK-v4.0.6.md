# KafePin Pro v4.0.6 STABLE LOCK

Bu kilit, sahada doğrulanan çalışan v4.0.6 R2 paketini ve ondan yalnız metadata değişikliğiyle üretilen STABLE artifact'i değişmez yayın referansı olarak tanımlar.

## Değişmez saha kaynağı

- Paket: `KafePin-Pro-Update-v4.0.6-CLIENT-PERFORMANS-UNIFIED-TEST-R2.zip`
- SHA-256: `bceae3b96db509121b7232439848dd0dc9860b177ac45e6a49ea20fa039d395c`
- Boyut: `835801` bayt
- Durum: sahada çalışan ve doğrulanan değişmez TEST kaynak paketi

## STABLE yayın artifact'i

- Paket: `KafePin-Pro-Update-v4.0.6-STABLE.zip`
- SHA-256: `f6446ef5538eec9cd2cb4df2c6d72efc702b02df329e293333506e41ec74a6a4`
- Boyut: `835933` bayt
- Build revision: `v406-stable-clientperformans-unified-r2-metadata-r1`
- Kaynağa göre yalnız `update.json` ve `kafepin-pro-version.json` STABLE/FINAL yayın metadata'sına çevrilmiştir.
- Diğer bütün ZIP üyelerinin adları ve içerikleri kaynak saha paketiyle byte düzeyinde aynıdır.
- `database.db`, `database.db-wal` ve `database.db-shm` pakette yoktur.

## Korunacak davranışlar

- Client Yönetim PRO ayrı sekme/servis olarak kaldırılmıştır.
- Tek istemci yönetim ekranı Client Performans PRO'dur.
- Client Performans PRO kartlarında EveryCafe oturumu, başlangıç zamanı, kalan süre, Uyandır, Yeniden Başlat ve Görev Sonlandır işlevleri korunur.
- 50/10 WebLimit ve mevcut performans telemetrisi korunur.
- CV Oluştur PRO üst menüde Yazıcı PRO'nun hemen yanında kalır.
- MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO, CV Oluştur PRO, finans, spin/session, monitor ve diğer çalışan ana özellikler kırpılmaz.
- EveryCafe veritabanı salt-okunur kalır.

## Değişiklik politikası

v4.0.7 ve sonrası bu kilitli davranışı başlangıç kabul eder. Cleanup/refactor/feature clipping adı altında çalışan özellik kaybı yapılamaz. Kaynak saha paketinin byte içeriği değiştirilmez; sonraki geliştirme yeni sürüm numarasıyla yapılır.
