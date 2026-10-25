# KafePin Pro v4.0.80 STABLE / FINAL

Yayın tarihi: 24.10.2026

## Kilitlenen yapı

- Ana KafePin payloadı mevcut çalışan saha kurulumundan kaynak-kilitli alınarak kümülatif FINAL pakete eklendi; Mining Pro v4.0.80 zorunlu bileşen olarak korunur.
- TV monitöründe üye oturumu bakiye, süre, bonus ve hesaptan bilgileriyle diğer ücretli masalarla aynı büyük kart düzeninde; sayfa başına iki büyük kart gösterilir.
- Ücretsiz ve EveryCafe bekleme masaları monitörde gösterilmez.
- Ana pencere ve PRO başlangıçları non-blocking/health-first çalışır; çalışan servis gereksiz yere öldürülmez.
- Mining Pro 17897 startup self-heal, health JSON whitespace düzeltmesi ve 15 dakika heartbeat yoksa OFFLINE davranışı korunur.
- ANA-PC SRBMiner BAT `ShellExecute/Open`, BAT klasörü working directory ve mining sırasında monitörün açık kalması korunur.
- iOS/Tailscale KafePin Admin Mining Pro sekmesi; BigONE, Binance BEP20, net kâr ve elektrik hesapları korunur.
- Disk sağlık uyarısı yalnız boş alan 10 GB altına düştüğünde görünür; 10 GB ve üzeri normaldir.

## Yeni kafe paketi

- Mining Pro kurulum sırasında diğer PRO bileşenlerinden bağımsız olarak sorulur.
- Seçilirse `C:\KafePinPro\MiningPRO` altında, 17897 portunda kurulur.
- Pearl/2Miners, BigONE ve Binance BEP20 cüzdan adresleri ile API alanları boş gelir.
- İşletme kendi cüzdan ve API bilgilerini panelden girer.
- Paket `database.db`, WAL/SHM, `.env`, log, token, müşteri verisi veya başka işletmeye ait config içermez.
- WebLimit Agent için ortak `control.key` taşınmaz; her Client kurulumunda 256-bit benzersiz anahtar üretilir ve ACL yalnız SYSTEM/Yöneticiler olacak şekilde sınırlandırılır.

## Koruma doğrulamaları

- Client v3.1.65 / HOTFIX8 çalışma kodu ve WebLimit Agent EXE byte-for-byte korunur; yalnız kurucu ortak anahtar yerine benzersiz anahtar üretir.
- Update lifecycle testleri 6/6 geçti.
- PowerShell, JavaScript, JSON, C# build ve Mining Pro Python syntax kontrolleri geçti.
- Mining Pro izole 27897 portunda `ok:true`, `app:KafePin Mining Pro`, `version:4.0.80` döndürdü; üç cüzdan alanı da boş kaldı.
- Her iki ZIP tüm girişleri okunarak CRC ve manifest/SHA-256 bütünlüğünden geçirildi.

Eski STABLE ve yeni-kafe paketleri değiştirilmemiştir.
