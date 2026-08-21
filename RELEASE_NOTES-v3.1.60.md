# KafePin Pro v3.1.60 STABLE — Kümülatif Yayın

Temel kurulum sürümü **v3.1.29**'dur. Bu paket, arada başka paket gerektirmeden doğrudan v3.1.60'a günceller.

## Dahil edilenler

- **Yazıcı PRO:** 17891 tarama/yazdırma servisi ile 17893 gelir servisinin sağlık sürümleri 3.1.60'ta birleştirildi. Servis hostu artık eski sürüm eşleşmesi yüzünden yeniden onarım döngüsüne girmez; çalışma günlükleri kullanıcı profilindeki `LocalAppData\KafePinYaziciPRO\logs` altındadır.
- **Client Yönetim PRO:** KafePin masaüstüne gömülü, bağımsız loopback servisi (`127.0.0.1:17894`) olarak eklenmiştir. EveryCafe yalnız salt-okunur açılır. Masa uyandırma (WOL), bilgisayarı kapatma ve yeniden başlatma gerçek istemci paketleriyle çalışır. Hesap/masa kapatma, kilitleme, süreli-süresiz-ücretsiz oturum açma bu panelde yoktur.
- **Yeni Kafe kurulumu:** MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO ve Client Yönetim PRO kurulumda ayrı ayrı sorulur.

## Korunan sınırlar

- `server.js`, KafePin finansı, session, spin, EveryCafe yazımı, Telegram ve gün sonu mantığı değiştirilmemiştir.
- EveryCafe veritabanına yazma yapan SQL bulunmaz; Client Yönetim PRO `mode=ro` ile bağlanır.
- MP3 Bot PRO, Yazıcı PRO ve Teknik Servis PRO bağımsız bileşen olarak korunur.

## Yayın öncesi doğrulama

- Yazıcı PRO `17891/api/health` ve `17893/health`: `ok=true`, sürüm `3.1.60`.
- Client Yönetim PRO `api/health` ve `api/clients`: bağımsız servis, 20 masa ve `everyCafeReadOnly=true`.
- Yazıcı/Client Python kaynakları AST ile, Yazıcı Node kaynağı ve değişmeden korunan `server.js` `node --check` ile doğrulandı.
- PRO bileşen kurucusu, Yazıcı servis hostu ve masaüstü kurulum PowerShell parser kontrolünden geçti.
- KafePin masaüstü C# kaynağı WebView2 referanslarıyla derlendi.
- Güncelleme ve Yeni Kafe ZIP'leri açılarak zorunlu dört bileşen arşivi kontrol edildi.
