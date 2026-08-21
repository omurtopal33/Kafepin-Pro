# KafePin Pro Güncelleme Merkezi

## Sürüm düzeni

- **v3.1.29:** Yeni Kafe kurulum / bootstrap tabanı.
- **v3.1.49:** Önceki kararlı kümülatif sürüm.
- **v3.1.60:** Güncel **STABLE / KÜMÜLATİF** sürüm. v3.1.29'dan ara paket gerekmeden doğrudan uygulanır.
- TEST paketleri yalnız `latest-test.json` üzerinden bildirilir; `latest.json` yalnız güncel STABLE sürümünü gösterir.

## Yeni Kafe kurulumu

`KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip` mevcut Ana Sunucu ve Client EXE yapısını korur. Ana Sunucu kurulumu v3.1.60 STABLE paketini tek adımda uygular; ardından bağımsız PRO bileşenleri ayrı ayrı sorar.

Kurulum ekranı **“KafePin Pro v3.1.60 STABLE — kurulum tabanı v3.1.29”** ifadesini gösterir. Teknik bootstrap karşılaştırması v3.1.29 ile devam eder; yalnız STABLE `latest.json` okunur.

- MP3 Bot PRO (`C:\KafePinMp3BotPRO`)
- Yazıcı PRO (`C:\KafePin\KafePinYaziciPRO`)
- Teknik Servis PRO (`C:\KafePinTeknikServisPRO`)
- Client Yönetim PRO (`C:\KafePin\KafePinClientYonetimPRO`)

Client EXE, client ping, çark, session, 20:00 işletme günü ve EveryCafe davranışları ana kurallara göre korunur.

## Güvenlik ve etki alanı

- EveryCafe yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe'ye yazma yapılmaz.
- KafePin çekirdeği; `server.js`, session, spin, Telegram, gün sonu ve finans davranışları değiştirilmez.
- Kafe DB, tokenlar, IP ayarları, Telegram bilgileri ve yedekler güncelleme paketlerinde bulunmaz.
- Yazıcı PRO finans kaydı yalnız kullanıcı açıkça onay verdiğinde KafePin Doğrudan Satış'a gider; aynı işlem ikinci kez kaydedilmez.

## Depoda tutulan paketler

Önceki kararlı paketler ve güncel paket tutulur:

- `KafePin-Pro-Update-v3.1.29.zip`
- `KafePin-Pro-Update-v3.1.49.zip`
- `KafePin-Pro-Update-v3.1.60.zip`
