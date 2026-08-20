# KafePin Pro Update Center

Bu depo KafePin Pro güncelleme paketleri içindir.

## KİLİTLİ / STABLE DURUM

- **v3.1.29 = STABLE FULL BASE.** Yeni kafe kurulumu ve tüm kümülatif güncellemelerin güvenli tabanıdır.
- **v3.1.45 = FINAL STABLE.** Sahada/testte doğrulanan v3.1.44 EveryCafe oturum-otoritesi davranışını, v3.1.43 güvenilirlik/20:00/yedek/sağlık altyapısını ve ayrıntılı Sürüm Notları düzeltmesini kapsayan kilitli referans sürümdür.
- **v3.1.46 = güncel TEST / saha doğrulama adayı.** v3.1.45 çekirdeğini korur ve yalnız EveryCafe çark-hazır masa bildirimi entegrasyonunu ekler.
- v3.1.46 kümülatiftir; v3.1.29 üzerine doğrudan kurulabilir. Ara sürümleri tek tek kurmak gerekmez.
- v3.1.46 saha testi tamamlanıp ayrıca onaylanana kadar **FINAL STABLE referans v3.1.45** olarak kalır.

## v3.1.46 çark-hazır bildirimi

- Yeni müşteri KafePin çark sayfasını hiç açmadıysa sayaç başlamaz ve EveryCafe mesajı gönderilmez.
- İlk gerçek sayfa açılışında sabit 45 dakika başlar; sayfa kapansa bile aktif EveryCafe oturumu boyunca gerçek zaman ilerler.
- Süre dolunca yalnız ilgili masaya bir kez **“🎁 Çark hakkınız hazır! Çarkınızı çevirebilirsiniz.”** mesajı gönderilir.
- Başarılı spin sonrası yeni 45 dakika başlar; yeni döngü dolunca yeniden yalnız bir kez bildirim gider.
- EveryCafe oturumu kapanınca KafePin bildirim/sayaç durumu temizlenir; yeni müşteri eski müşteriden süre veya bildirim devralmaz.
- Mesaj EveryCafe Client'ın sahada doğrulanan UDP Messenger kanalı üzerinden hedef masaya gönderilir; EveryCafe DB'ye mesaj kaydı yazılmaz.
- Başarılı gönderim ve anlamlı gönderim hataları **Canlı Sistem Günlüğü**'ne spam yapmadan kaydedilir.

## Güncelleme güvenliği

- Kafe veritabanı, token, IP, Telegram bilgisi ve yedek kesinlikle yüklenmez.
- `latest.json` şu anda saha testi için **v3.1.46** paketini bildirir.
- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` ile salt okunur kullanılır; EveryCafe'ye hiçbir yazma yapılmaz.
- Genel Ciro = EveryCafe gerçek gelir + KafePin doğrudan satış. Çark maliyeti genel cirodan düşülmez; ayrı maliyet olarak izlenir.
- Çark yaşam döngüsü sabit 45 dakikadır: yeni müşteri çark sayfasını ilk kez açmadan sayaç başlamaz; ilk gerçek açılışta 45:00 başlar; pencere kapansa da gerçek zaman ilerler; spin sonrası yeniden 45:00 başlar.
- İşletme günü sınırı 20:00'dir; 20:00 sonrası gelir yeni işletme gününe aittir. Devir geliri ikinci kez ciroya eklenmez.
- `server.js` ana işleyişi ve Monitor/Admin tema-yapısı onaysız değiştirilmez; değişiklik önce konuşulur, kullanıcı onayından sonra hedefli uygulanır.
- Her yeni sürümde ayrıntılı sürüm notu zorunludur ve Sürüm Notları ekranında görünürlüğü paket testinde doğrulanır.
- v3.1.45 yerinde değiştirilmez; yeni çalışmalar yeni kümülatif sürüm numarasıyla devam eder.
