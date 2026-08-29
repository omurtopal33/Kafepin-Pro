# KafePin Pro Güncelleme Merkezi

## Güncel sürüm düzeni

- **v4.0.11 STABLE/FINAL:** Güncel saha sürümüdür; v4.0.10 STABLE tam tabanı korunarak v4.0.11 R4 WebLimit ve TV monitör modu exact olarak kilitlenmiştir.
- **Yeni kafe dağıtımı değişmez:** `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` çevrimdışı kurulum tabanıdır. Her STABLE sürüm için yeni bir yeni-kafe ZIP'i üretilmez.
- Yeni kafe v3.1.64 FINAL ile kurulur; internet varsa yalnız `latest.json` içindeki daha yeni STABLE sürümü tek adımda alır.
- Ara sürümlerin tek tek kurulması gerekmez.
- TEST paketleri STABLE dağıtım kaynağı değildir; `latest.json` yalnız güncel STABLE güncellemeyi gösterir.

## Yeni Kafe kurulumu

1. `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` içindeki `KURULUMU_BASLAT.cmd` çalıştırılır.
2. Kurucu internet olmasa da v3.1.64 FINAL tabanını kurabilir.
3. İnternet varsa `latest.json` kontrol edilir; daha yeni STABLE varsa doğrudan güncel kümülatif STABLE'a yükseltilir.
4. Ara update sürümleri kurulmaz.

PRO klasör düzeni korunur:

- MP3 Bot PRO: `C:\KafePinPro\MP3BotPRO`
- Yazıcı PRO: `C:\KafePinPro\YaziciPRO`
- Teknik Servis PRO: `C:\KafePinPro\TeknikServisPRO`
- Client Performans PRO: `C:\KafePinPro\ClientPerformansPRO`
- CV Oluştur PRO: `C:\KafePinPro\CVOlusturPRO`

## v4.0.11 STABLE kilitleri

- Client Performans PRO WebLimit: tek masa ve tüm masalar ayarları ayrıdır; offline masaların toplu ayarı reconnect sırasında yeniden uygulanır; `Kapat` tercihi kalıcıdır.
- Monitor TV modu yalnız `monitor.html?tv=1` ile açılır; aynı anda 3 online masa gösterilir, ping/Mbps/süre/ücret/ödül bilgileri korunur ve sayfalar 9 saniyede değişir. Normal monitor görünümü değişmez.
- v4.0.10 STABLE ZIP’indeki tüm gerçek dosyalar korunmuştur; v4.0.11 R4 overlay’leri byte düzeyinde doğrulanmıştır.

- v4.0.10 saha adayı çalışan haliyle korunur; özellik kırpılmaz.
- ÖSYM / AİS tam koyu mod görünümü ve mevcut arayüz davranışları korunur.
- MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO, Client Performans PRO ve CV Oluştur PRO payloadları korunur.
- EveryCafe veritabanı yalnız salt-okunur erişimle kullanılır; finans, spin/session, 45 dakika yaşam döngüsü ve 20:00 işletme günü davranışları değiştirilmez.
- Güncelleme paketi veritabanı dosyalarını taşımaz; çalışan DB'ye dokunulmaz.
- Saha kontrolünde KafePin Pro boşta CPU/RAM tüketimi düşük, pencere açılışı hızlı ve PRO servisleri kararlı gözlenmiştir.
- MP3 Bot tarafında yalnız geçici Chrome cache alanları temizlenmiştir; profil yapısı, `.venv`, servis dosyaları ve runtime kodu korunur.

## Güvenlik ve ana yapı

- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` / salt-okunur yöntemlerle okunur; EveryCafe'ye yazma yapılmaz.
- KafePin session, spin, 45 dakika yaşam döngüsü, 20:00 işletme günü, Telegram ve ana finans davranışları onaysız değiştirilmez.
- Monitor/Admin tema ve kart yapısı onaysız değiştirilmez.
- Aynı EveryCafe hareketi ikinci kez gelir veya promosyon olarak kaydedilmez.

## Depo düzeni

Korunacak temel dağıtımlar:

- `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` — yeni kafe çevrimdışı tabanı.
- `KafePin-Client-v3.1.64.zip` — eşleşen Client dağıtımı.
- Güncel `KafePin-Pro-Update-v4.0.11-STABLE.zip` — aktif STABLE update.

Aktif güncelleme kaynağı `latest.json` üzerinden doğrudan `KafePin-Pro-Update-v4.0.11-STABLE.zip` dosyasına gider. Eski ara sunucu update paketleri aktif dağıtım zincirinde kullanılmaz.

Ayrıntılı değişmez saha kilidi: `STABLE_LOCK-v4.0.11.md`.
