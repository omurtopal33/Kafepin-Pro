# KafePin Pro Güncelleme Merkezi

## Sürüm düzeni

- **v3.1.60:** Kilitli **FINAL / STABLE** temel kurulum sürümüdür.
- v3.1.60 yeni kafeler için değişmeyen kurulum tabanıdır; yeni kafe paketi her sürümde yeniden üretilmez.
- Bundan sonraki tüm geliştirmeler **v3.1.61+** olarak, v3.1.60 üzerine **tek adımda uygulanabilen kümülatif STABLE UPDATE** şeklinde yayınlanır.
- TEST paketleri yalnız `latest-test.json` üzerinden bildirilir; `latest.json` yalnız güncel STABLE güncellemeyi gösterir.

## Yeni Kafe kurulumu

Yeni bir kafede kurulum sırası sabittir:

1. `KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip` ile **v3.1.60 FINAL / STABLE** temel kurulum yapılır.
2. Kurulum tamamlandıktan sonra yalnız `latest.json` içindeki **en güncel kümülatif STABLE UPDATE** kontrol edilir ve varsa tek seferde uygulanır.
3. Ara sürümlerin tek tek kurulması gerekmez.
4. Sistem zaten `latest.json` sürümündeyse başlangıçta tekrar “güncelleme var” uyarısı gösterilmez.

Kurulum ekranı **“KafePin Pro v3.1.60 FINAL / STABLE”** ifadesini gösterir. Ana Sunucu kurulumu önce EveryCafe kullanımı ve varsa salt-okunur `ecmdata.ecm` yolu, masa sayısı, yedek klasörü ve isteğe bağlı Telegram bilgilerini sorar. Ardından PRO hizmetleri ayrı ayrı sorulur:

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

## Depoda tutulan temel paket

Yeni kafe için kilitli temel paket:

- `KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip`

Güncelleme tarafında bundan sonra yalnız en güncel kümülatif STABLE update kullanılır; v3.1.60 temel paket yerinde değiştirilmez.
