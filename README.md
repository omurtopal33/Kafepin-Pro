# KafePin Pro Güncelleme Merkezi

## Sürüm düzeni

- **v3.1.29:** Eski kurulum / bootstrap tabanı.
- **v3.1.49:** Kilitli **STABLE** taban. Yeni kafe kurulumunda esas kararlı sürümdür.
- **v3.1.53:** v3.1.49 üzerine doğrudan kurulabilen **KÜMÜLATİF CANDIDATE** güncelleme. v3.1.50 / v3.1.51 / v3.1.52 paketlerini ayrı ayrı kurmak gerekmez.
- v3.1.53 saha testinden sonra kullanıcı açıkça **“kitle”** demeden STABLE yapılmaz.

## Yeni Kafe kurulumu

`KafePin-Pro-Yeni-Kafe-STABLE-v3.1.49.zip` içindeki mevcut Ana Sunucu ve Client EXE’leri kullanılır. Ana Sunucu kurulumu v3.1.49 STABLE tabanını kurar; güncelleyici `latest.json` üzerinden en güncel kümülatif paketi görür.

- MP3 Bot PRO (`C:\KafePinMp3BotPRO`)
- Yazıcı PRO (`C:\KafePin\KafePinYaziciPRO`)
- Teknik Servis PRO (`C:\KafePinTeknikServisPRO`)

Client EXE, client ping, çark, session, 20:00 işletme günü ve EveryCafe davranışları ana kurallara göre korunur.

## Güvenlik ve etki alanı

- EveryCafe yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe’ye yazma yapılmaz.
- KafePin çekirdeği; session, spin, Telegram, gün sonu ve finans davranışları onaysız değiştirilmez.
- Kafe DB, tokenlar, IP ayarları, Telegram bilgileri ve yedekler güncelleme paketlerinde bulunmaz.
- Yazıcı PRO finans kaydı yalnız kullanıcı açıkça onay verdiğinde KafePin Doğrudan Satış’a gider; aynı işlem ikinci kez kaydedilmez.

## Depoda tutulan KafePin sürüm paketleri

Yalnız şu sürümler tutulur:

- `KafePin-Pro-Update-v3.1.29.zip`
- `KafePin-Pro-Update-v3.1.49.zip`
- `KafePin-Pro-Update-v3.1.53.zip`

Ayrıca yeni kafe kurulumu için `KafePin-Pro-Yeni-Kafe-STABLE-v3.1.49.zip` korunur.
