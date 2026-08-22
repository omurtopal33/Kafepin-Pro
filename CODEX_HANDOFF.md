# KafePin Pro — Güncel Devir Notu

## Kilitli referans

- **v3.1.60 FINAL / STABLE** tek kilitli dağıtım referansıdır.
- `KafePin-Pro-Update-v3.1.60.zip` mevcut v3.1.60 kurulumunu doğrulamak veya onarmak için kullanılır.
- `KafePin-Pro-Yeni-Kafe-STABLE-v3.1.60.zip` yeni kafeyi doğrudan kurar.
- Sonraki her değişiklik v3.1.61+ sürüm numarasıyla, v3.1.60 üzerine kümülatif STABLE güncelleme olarak çıkar. Final paketi yerinde değiştirilmez.

## Yeni kafe kurulumu

Ana KafePin kurulumu ile PRO hizmetleri ayrıdır. Ana çekirdek `C:\KafePin` altında kalır; yeni kurulumdaki PRO hizmetleri `C:\KafePinPRO` altında birbirinden bağımsız kurulur. Yeni kurulumda önce EveryCafe kullanımı ve varsa salt-okunur `ecmdata.ecm` yolu, masa sayısı, yedek klasörü ve isteğe bağlı Telegram ayarları sorulur. Sonra aşağıdaki PRO hizmetleri ayrı ayrı seçilir:

- MP3 Bot PRO
- Yazıcı PRO
- Teknik Servis PRO
- Client Yönetim PRO

Paket hiçbir kafe veritabanı, token, IP ayarı, Telegram bilgisi veya yedek içermez. EveryCafe bağlantısı her zaman salt-okunurdur.

## Yayın kontrolü

Her sonraki sürümde JavaScript/PowerShell/Python sözdizimi, ZIP bütünlüğü, SHA-256 ile `latest.json` eşleşmesi, dört PRO bileşeni, EveryCafe read-only erişimi, 45 dakika çark yaşam döngüsü, finans ve 20:00 gün sınırı doğrulanır. Yönetim panelindeki sürüm notu görünür olmadan paket yayınlanmaz.
