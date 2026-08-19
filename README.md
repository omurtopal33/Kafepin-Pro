# KafePin Pro Update Center

Bu depo KafePin Pro güncelleme paketleri içindir.

## KİLİTLİ / STABLE DURUM

- **v3.1.29 = STABLE FULL BASE.** Yeni kafe kurulumu ve tüm kümülatif güncellemelerin güvenli tabanıdır.
- **v3.1.45 = FINAL STABLE.** Sahada/testte doğrulanan v3.1.44 EveryCafe oturum-otoritesi davranışını, v3.1.43 güvenilirlik/20:00/yedek/sağlık altyapısını ve ayrıntılı Sürüm Notları düzeltmesini kapsayan güncel kilitli sürümdür.
- v3.1.45 kümülatiftir; v3.1.29 üzerine doğrudan kurulabilir. Ara sürümleri tek tek kurmak gerekmez.
- Depoda dağıtım paketi olarak yalnız **v3.1.29 tabanı** ve **v3.1.45 FINAL STABLE** tutulur.
- v3.1.44 sahada/testte kullanılan geliştirme tabanıdır; artık dağıtım paketi değildir.

## Güncelleme güvenliği

- Kafe veritabanı, token, IP, Telegram bilgisi ve yedek kesinlikle yüklenmez.
- `latest.json` aktif FINAL STABLE sürümü bildirir ve şu anda **v3.1.45**'i gösterir.
- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` ile salt okunur kullanılır; EveryCafe'ye hiçbir yazma yapılmaz.
- Genel Ciro = EveryCafe gerçek gelir + KafePin doğrudan satış. Çark maliyeti genel cirodan düşülmez; ayrı maliyet olarak izlenir.
- Çark yaşam döngüsü sabit 45 dakikadır: yeni müşteri çark sayfasını ilk kez açmadan sayaç başlamaz; ilk gerçek açılışta 45:00 başlar; pencere kapansa da gerçek zaman ilerler; spin sonrası yeniden 45:00 başlar.
- İşletme günü sınırı 20:00'dir; 20:00 sonrası gelir yeni işletme gününe aittir. Devir geliri ikinci kez ciroya eklenmez.
- `server.js` ana işleyişi ve Monitor/Admin tema-yapısı onaysız değiştirilmez; değişiklik önce konuşulur, kullanıcı onayından sonra hedefli uygulanır.
- Her yeni sürümde ayrıntılı sürüm notu zorunludur ve Sürüm Notları ekranında görünürlüğü paket testinde doğrulanır.
- Bundan sonraki değişiklikler **v3.1.45 yerinde değiştirilmeden v3.1.46+** yeni kümülatif sürüm numarası ile devam eder.
