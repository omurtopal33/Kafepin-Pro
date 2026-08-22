# KafePin Pro v3.1.60 FINAL / STABLE — Kilitli Yayın

v3.1.60, yeni kafe kurulumunun ve bundan sonraki tüm kümülatif STABLE güncellemelerin tek referans tabanıdır. Bu paketin kendisi yerinde değiştirilmez; sonraki her değişiklik v3.1.61+ olarak ayrı güncelleme paketi halinde yayınlanır.

## Dahil edilenler

- **Masaüstü yan paneller:** WhatsApp Business, WhatsApp Kişisel ve Telegram ayrı WebView2 profilleriyle kalıcı oturumlu yan panel olarak çalışır. Bildirim rozetleri, panel içi yenileme, dış alana tıklayınca kapanma ve panel genişliğine göre küçülen üst menü bulunur.
- **MP3 Bot PRO:** Seçilebilir müşteri ve Favori Listem yolları, gerçek dosya kopyalı dolu/boş yıldız durumu, izin hatası dayanıklılığı, hızlı arşiv klasör gezgini, MP3/FLAC/WAV/WMA oynatma ve USB MP3/film/oyun satış hazırlama araçları paketlendi.
- **Yazıcı PRO:** Atomik durum kaydındaki Windows `EPERM` yeniden adlandırma hatasına dayanıklı geri dönüş, kimlik/fotokopi/tarama/PDF akışları, WhatsApp ve USB hızlı dosya alma, yazıcı algılama ve Son Yazdırmalar doğruluğu geliştirildi. İptal veya silinen taslaklar gelir geçmişine eklenmez.
- **Teknik Servis PRO:** A4 servis fişinde logonun ilk baskıda yüklenmesi, Nakit/Kart bilgisinin fişte görünmesi ve tahsilatın Doğrudan Satış'a yalnız bir kez aktarılması düzeltildi.
- **Client Yönetim PRO:** Gerçek çevrimiçi masalar üste sıralanır; kapanan cihazlar doğal masa sırasına döner. WOL, yeniden başlatma, süreli/süresiz/ücretsiz açılış, açık oturuma süre ekleme, başlangıç zamanı ve canlı kalan süre gösterilir.
- **Güvenli uygulama sonlandırma:** Masa kartında güçlü onayla çalışan kullanıcı uygulamalarını sonlandırma eklendi. Windows ve EveryCafe oturumu açık kalır; “Bilgisayarı kapat” kaldırılmıştır.
- **Yeni Kafe:** Ana Sunucu ve Client EXE düzeni korunur. Kurulum önce EveryCafe kullanımı ve varsa `ecmdata.ecm` salt-okunur bağlantı yolu, masa sayısı, yedek klasörü ve isteğe bağlı Telegram bilgilerini sorar. Ardından MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO ve Client Yönetim PRO ayrı ayrı sorulur. Ana KafePin `C:\KafePin` altında kalır; PRO hizmetleri bağımsız klasör/servis yapısıyla `C:\KafePinPRO\` altında kurulur.

## EveryCafe ve çekirdek sınırları

- EveryCafe veritabanı yalnız salt okunur açılır; SQL `INSERT`, `UPDATE`, `DELETE`, `REPLACE` veya şema değişikliği yapılmaz.
- Süreli/süresiz/ücretsiz açılış ve süre ekleme EveryCafe'nin kendi kullanıcı arayüzü üzerinden uygulanır ve salt-okunur veriden doğrulanır.
- Hesap/masa kapatma, tahsilat ve EveryCafe finans otoritesi bu panelde bulunmaz.
- KafePin ücret, session, spin, finans, Telegram sağlık raporu ve 20:00 gün sonu mantığı korunur.

## Yayın öncesi doğrulama

- JavaScript, Python ve PowerShell sözdizimi kontrolleri.
- Güncelleme ve Yeni Kafe ZIP bütünlük testi; dört bağımsız PRO bileşeninin zorunlu dosya kontrolü.
- Güncelleme ZIP'i için SHA-256 üretimi ve `latest.json` eşleşmesi.
- `latest.json` yalnız v3.1.60 STABLE'ı, `latest-test.json` ise boş TEST kanalını gösterir.
- Client Yönetim PRO kaynaklarında EveryCafe yazan SQL bulunmadığı ve servis sağlık bilgisinin `readOnly=true` döndürdüğü kontrol edilir.

## Bilinen sınırlar

- EveryCafe arayüzüyle oturum açma veya süre ekleme sırasında EveryCafe kısa süre öne gelebilir.
- “Çalışan uygulamaları sonlandır” kaydedilmemiş kullanıcı verisini kaybettirebilir; bu nedenle işlem onaysız yürütülmez.
