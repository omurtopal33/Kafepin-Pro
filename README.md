# KafePin Pro Güncelleme Merkezi

## Sürüm düzeni

- **v3.1.60:** Kilitli **FINAL / STABLE** sürüm ve bundan sonraki tüm kümülatif güncellemelerin tek tabanıdır.
- TEST paketleri yalnız `latest-test.json` üzerinden bildirilir; `latest.json` yalnız güncel STABLE sürümünü gösterir.

## Yeni Kafe kurulumu

`KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip` mevcut Ana Sunucu ve Client EXE yapısını korur. Yeni bir kafe doğrudan bu FINAL paketiyle kurulur; sonrasında çıkacak her kümülatif güncelleme bu sürümün üzerine uygulanır.

Kurulum ekranı **“KafePin Pro v3.1.60 FINAL / STABLE”** ifadesini gösterir. Yalnız STABLE `latest.json` okunur.

Ana Sunucu kurulumu önce EveryCafe kullanımı ve varsa salt-okunur `ecmdata.ecm` yolu, masa sayısı, yedek klasörü ve isteğe bağlı Telegram bilgilerini sorar. Ardından PRO hizmetleri ayrı ayrı sorulur:

- MP3 Bot PRO (`C:\KafePinPRO\MP3Bot`)
- Yazıcı PRO (`C:\KafePinPRO\Yazici`)
- Teknik Servis PRO (`C:\KafePinPRO\TeknikServis`)
- Client Yönetim PRO (`C:\KafePinPRO\ClientYonetim`)

Client EXE, client ping, çark, session, 20:00 işletme günü ve EveryCafe davranışları ana kurallara göre korunur.

## Güvenlik ve etki alanı

- EveryCafe yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe'ye yazma yapılmaz.
- KafePin çekirdeğinin session, spin, Telegram sağlık raporu, 20:00 gün sonu ve finans davranışları değiştirilmez.
- Kafe DB, tokenlar, IP ayarları, Telegram bilgileri ve yedekler güncelleme paketlerinde bulunmaz.
- Yazıcı PRO finans kaydı yalnız kullanıcı açıkça onay verdiğinde KafePin Doğrudan Satış'a gider; aynı işlem ikinci kez kaydedilmez.

## Depoda tutulan paketler

Yayın deposunda yalnız kilitli final paketler tutulur:

- `KafePin-Pro-Update-v3.1.60.zip`
- `KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip`
