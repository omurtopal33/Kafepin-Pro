# KafePin Pro Güncelleme Merkezi

## Kararlı sürüm

- **v3.1.29:** Yeni Kafe kurulum temeli.
- **v3.1.49:** Güncel **STABLE / KÜMÜLATİF** sürüm. v3.1.29’dan ara paket kurmadan doğrudan uygulanır.
- Bundan sonraki yayınlar **TEST** güncellemesi olarak ilerler. TEST paketleri yalnız `latest-test.json` üzerinden bildirilir; `latest.json` yalnız STABLE sürümü gösterir ve v3.1.49’da kalır.

## Yeni Kafe kurulumu

`KafePin-Pro-Yeni-Kafe-STABLE-v3.1.49.zip` içindeki mevcut Ana Sunucu ve Client EXE’leri kullanılır. Ana Sunucu kurulumu internet bağlantısıyla GitHub’daki v3.1.49 paketini tek adımda uygular. Ardından üç bağımsız bileşen ayrı ayrı sorulur:

Kurulum ekranı **“KafePin Pro v3.1.49 STABLE — kurulum tabanı v3.1.29”** ifadesini gösterir. Teknik bootstrap karşılaştırması v3.1.29 ile devam eder; yalnız STABLE `latest.json` okunur.

- MP3 Bot PRO (`C:\KafePinMp3BotPRO`)
- Yazıcı PRO (`C:\KafePin\KafePinYaziciPRO`)
- Teknik Servis PRO (`C:\KafePinTeknikServisPRO`)

Client EXE, client ping ve çark kurulum davranışı değişmez.

## Güvenlik ve etki alanı

- KafePin çekirdeği; session, spin, Telegram, gün sonu ve EveryCafe davranışı korunur.
- EveryCafe yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe’ye yazma yapılmaz.
- Teknik Servis PRO, yalnız kullanıcı tahsil edilmiş bir kayıt kaydettiğinde mevcut loopback doğrudan satış uç noktasına Nakit/Kart kaydı gönderir. Satış kimliği saklanır; aynı servis için ikinci kayıt oluşmaz.
- Kafe DB, tokenlar, IP ayarları, Telegram bilgileri ve yedekler güncelleme paketinde bulunmaz.

## Paketler

Depoda yalnız şu iki sürüm paketi tutulur:

- `KafePin-Pro-Update-v3.1.29.zip`
- `KafePin-Pro-Update-v3.1.49.zip`
