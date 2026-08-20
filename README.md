# KafePin Pro Update Center

Bu depo KafePin Pro güncelleme paketleri içindir.

## KİLİTLİ / STABLE DURUM

- **v3.1.29 = STABLE FULL BASE.** Yeni kafe kurulumu ve tüm kümülatif güncellemelerin güvenli tabanıdır.
- **v3.1.45 = FINAL STABLE.** Sahada/testte doğrulanan v3.1.44 EveryCafe oturum-otoritesi davranışını, v3.1.43 güvenilirlik/20:00/yedek/sağlık altyapısını ve ayrıntılı Sürüm Notları düzeltmesini kapsayan kilitli referans sürümdür.
- **v3.1.48 = TEST / saha doğrulama kümülatif sürümü.** v3.1.45 FINAL STABLE çekirdeğini korur; bağımsız KafePin Yazıcı PRO masaüstü sekmesini ekler ve önceki v3.1.46/v3.1.47 düzeltmelerini içerir.
- v3.1.48 kümülatiftir; v3.1.29 üzerine doğrudan kurulabilir. Ara sürümleri tek tek kurmak gerekmez.
- FINAL STABLE referansı v3.1.45 olarak korunur.

## v3.1.48 — KafePin Yazıcı PRO

- Masaüstü uygulamasında `🖨️ Yazıcı PRO` sekmesi, MP3 Bot PRO gibi ayrı WebView2 paneli olarak açılır.
- Motor yalnız `127.0.0.1:17891` üzerinden çalışır; KafePin DB/session/finans/spin/EveryCafe/gün sonu/Telegram iş akışlarına erişmez.
- Kimlik Fotokopi: ön/arka yüz A4 üzerinde yan yana veya alt alta hazırlanır.
- Normal Tarama: sayfalar sırayla eklenir; PDF çoklu sayfa oluşur ve yazdırmada tüm sayfalar Windows kuyruğuna sırayla gider.
- Yazıcı ve WIA tarayıcı Windows cihaz listesinden seçilir. Epson L3150 için Epson Scan 2/WIA sürücüsü gerekir.
- Kalıcı arşiv varsayılan olarak yoktur; kullanıcı isterse PDF/JPG `Belgeler\KafePin Belgeler` içine kaydedilir. Klasör yalnız kullanıcı düğmeye bastığında açılır.

## Kümülatif olarak korunan v3.1.46 çark-hazır bildirimi

- Yeni müşteri KafePin çark sayfasını hiç açmadıysa sayaç başlamaz ve EveryCafe mesajı gönderilmez.
- İlk gerçek sayfa açılışında sabit 45 dakika başlar; sayfa kapansa bile aktif EveryCafe oturumu boyunca gerçek zaman ilerler.
- Süre dolunca yalnız ilgili masaya bir kez **“🎁 Çark hakkınız hazır! Çarkınızı çevirebilirsiniz.”** mesajı gönderilir.
- Başarılı spin sonrası yeni 45 dakika başlar; yeni döngü dolunca yeniden yalnız bir kez bildirim gider.
- EveryCafe oturumu kapanınca KafePin bildirim/sayaç durumu temizlenir; yeni müşteri eski müşteriden süre veya bildirim devralmaz.
- Mesaj EveryCafe Client'ın sahada doğrulanan UDP Messenger kanalı üzerinden hedef masaya gönderilir; EveryCafe DB'ye mesaj kaydı yazılmaz.
- Başarılı gönderim ve anlamlı gönderim hataları **Canlı Sistem Günlüğü**'ne spam yapmadan kaydedilir.

## Güncelleme güvenliği

- Kafe veritabanı, token, IP, Telegram bilgisi ve yedek kesinlikle yüklenmez.
- `latest.json` şu anda **v3.1.48 TEST** paketini bildirir; kilitli FINAL STABLE referansı v3.1.45'tir.
- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` ile salt okunur kullanılır; EveryCafe'ye hiçbir yazma yapılmaz.
- Genel Ciro = EveryCafe gerçek gelir + KafePin doğrudan satış. Çark maliyeti genel cirodan düşülmez; ayrı maliyet olarak izlenir.
- Çark yaşam döngüsü sabit 45 dakikadır: yeni müşteri çark sayfasını ilk kez açmadan sayaç başlamaz; ilk gerçek açılışta 45:00 başlar; pencere kapansa da gerçek zaman ilerler; spin sonrası yeniden 45:00 başlar.
- İşletme günü sınırı 20:00'dir; 20:00 sonrası gelir yeni işletme gününe aittir. Devir geliri ikinci kez ciroya eklenmez.
- `server.js` ana işleyişi ve Monitor/Admin tema-yapısı onaysız değiştirilmez; değişiklik önce konuşulur, kullanıcı onayından sonra hedefli uygulanır.
- Her yeni sürümde ayrıntılı sürüm notu zorunludur ve Sürüm Notları ekranında görünürlüğü paket testinde doğrulanır.
- v3.1.45 yerinde değiştirilmez; yeni çalışmalar yeni kümülatif sürüm numarasıyla devam eder.
