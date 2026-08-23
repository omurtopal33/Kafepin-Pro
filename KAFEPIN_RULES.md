# KafePin Pro – Değişmez Proje Kuralları

Bu dosya yeni sohbetlerde, Codex çalışmalarında ve yeni sürümlerde referans alınacak ana kuralları içerir.

## 1. Sürüm ve kurulum kuralları

- **v3.1.60 = kilitli yeni-kafe FINAL taban sürümüdür.** Yerinde değiştirilmez.
- **v3.1.64 = kilitli güncel saha FINAL / STABLE referansıdır.** Onaylanan Admin kart yapısı ve PRO servis yeniden başlatma davranışı korunur.
- Bundan sonraki geliştirmeler **v3.1.65+** yeni kümülatif sürüm numarasıyla, v3.1.60 kurulum tabanı üzerine ve v3.1.64 saha davranışları korunarak çıkar.
- v3.1.60 tarihsel bootstrap paketi yerinde değiştirilmez. Yeni kafe kurulumu: **`KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip`** ile çevrimdışı doğrudan v3.1.64; ardından yalnız daha yeni kümülatif STABLE UPDATE.
- Ara sürümlerin tek tek kurulması gerekmez.
- Her yeni sürüm önceki gerekli düzeltmeleri ve onaylı davranışları korur.

## 2. Değişiklik onayı ve ana yapı koruması

- **Çalışan ana yapı onaysız değiştirilmez.**
- Özellikle `server.js` içindeki ana işleyiş, finans, spin, EveryCafe entegrasyonu, kapanış/temizlik, 20:00 gün devri, güncelleme/yedek ve güvenlik akışları refactor edilmez veya davranışı değiştirecek şekilde yeniden yazılmaz.
- Bir değişiklik gerekiyorsa önce kullanıcıyla konuşulur: sorun, hedef, hangi dosya/fonksiyonların değişeceği, mevcut davranışa etkisi ve olası risk açıklanır.
- **Kullanıcı açıkça onay vermeden ana işleyişe kod değişikliği uygulanmaz.**
- Onaydan sonra yalnız gerekli ve hedefli değişiklik yapılır; ilgisiz çalışan bölümlere dokunulmaz.
- Bir düzeltme başka temel kuralı etkileyebilecekse kod yazmadan önce ayrıca belirtilir ve onay alınır.

## 3. Arayüz / tema koruması

- **Mevcut Monitor, Admin ve yönetim ekranlarının tema, renk, kart düzeni, yerleşim ve genel görsel yapısı onaysız değiştirilmez.**
- Çalışan HTML/CSS sırf düzenleme/refactor amacıyla yeniden yazılmaz.
- Yeni özellik gerekirse mevcut tasarıma uyumlu ve mümkün olduğunca küçük ekleme yapılır.
- Kartların yeri, başlığı, veri kaynağı veya görünümü değişecekse önce kullanıcıyla konuşulur ve onay alınır.
- Monitor teması ve mevcut görsel kimliği korunur; bir güncelleme başka bir özelliği düzeltirken arayüzü bozamaz.

## 4. EveryCafe entegrasyonu – değişmez güvenlik kuralı

- **KafePin, EveryCafe veritabanına ASLA yazmaz.**
- EveryCafe bağlantıları yalnız `sqlite3.OPEN_READONLY` ile açılır.
- EveryCafe tarafında `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP` veya başka herhangi bir yazma işlemi yapılmaz.
- Masa, oturum, satış, ücret, ödeme ve kapanış bilgileri EveryCafe'den yalnız okunur.
- KafePin'e ait session, spin, audit, yedek, muhasebe, ayar ve temizlik işlemleri yalnız KafePin'in kendi veritabanında yapılır.
- Her sürüm testinde EveryCafe bağlantılarının tamamının read-only olduğu ayrıca doğrulanır ve sürüm notuna yazılır.

## 5. Masa açık/kapalı otoritesi

- EveryCafe entegrasyonu açıksa **masa açık/kapalı kararında tek otorite EveryCafe'dir**.
- **EveryCafe'de müşteri masa hesabı açık = müşteri devam ediyor.** Ping kesilmesi, PC donması veya müşteri PC'sinin restart olması müşteriyi kapatmaz.
- **EveryCafe'de müşteri masa hesabı kapanmış = müşteri bitmiştir.** Ücretli/ücretsiz fark etmez; KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar.
- Ping yalnız PC'nin bağlantı/online bilgisidir; müşteri hesabını kapatma yetkisi yoktur.
- Eski 5 dakika / ping yoksa otomatik kapat yaklaşımı EveryCafe entegrasyonu açıkken kullanılmaz.
- EveryCafe'de kapanmış eski müşteriden sonradan ping/status/spin gelmesi eski oturumu yeniden diriltmemelidir.
- Kapanışta eski session/runtime/spin zamanlayıcısı/kilitler ve müşteriye özel geçici durumlar temizlenir; masa yeni müşteriye hazır olur.
- Finans tutarı tahmin edilmez; kapanış/tahsilat EveryCafe'nin gerçek salt-okunur kaydından senkronlanır.

## 6. Çark – 45 dakika ana yaşam döngüsü (DEĞİŞMEZ)

- Çark bekleme süresi sabit **45 dakika**.
- **Yeni müşteri KafePin çark sayfasını/penceresini hiç açmadıysa 45 dakika sayacı ASLA başlamaz.** PC'nin açık olması, ping gelmesi, EveryCafe masasının açık olması, server istekleri veya arka plan işlemleri sayacı başlatamaz.
- Müşteri çark sayfasını **ilk kez gerçekten açtığı anda** sayaç `45:00` olarak başlar; anında spin hakkı verilmez.
- Sayaç bir kez başladıktan sonra pencerenin kapatılması sayacı dondurmaz veya sıfırlamaz. Süre gerçek zamanla ilerlemeye devam eder.
- Pencere tekrar açılırsa müşteri **kalan gerçek süreyi** görür; 45 dakika geçmişse spin hazır görünür.
- Her başarılı spin sonrası aynı müşteri için sayaç **yeniden 45:00** olur ve gerçek zamanla devam eder.
- EveryCafe'de müşteri hesabı kapanınca eski müşterinin sayaç/runtime/spin hakkı durumu temizlenir.
- Yeni müşteri geldiğinde eski müşterinin süresi veya hakları devretmez. **Yeni müşterinin sayacı, kendi çark sayfasını ilk kez açana kadar başlamaz.**
- Mevcut **5 spin hakkı kuralı aktif müşteri/session bazında** korunur; eski müşterinin spin kayıtları yeni müşterinin 5 hakkına karışmaz.
- Yalnız Admin `Acil Hazır / force-ready` 45 dakika beklemeyi atlayabilir.
- EveryCafe ücretsiz/hediye süreleri çark sayacını değiştirmez.
- Test Mode / 1 dakika spin kısayolu yoktur.
- Hafta içi/hafta sonu fiyat ayrımı yoktur.
- Spin maliyetleri merkezi ve sabittir:
  - Normal 30 dk = 25 TL
  - Normal 60 dk = 50 TL
  - VIP 30 dk = 35 TL
  - VIP 60 dk = 70 TL
  - İçecek/atıştırmalık/anahtarlık = 20 TL

## 7. Finans kuralları

- **Genel Ciro = EveryCafe Gerçek Gelir + KafePin Doğrudan Satış**.
- Çark maliyeti genel cirodan düşülmez; ayrı maliyet olarak gösterilir.
- Net işletme sonucu hesaplarında gider, kart komisyonu ve çark maliyeti ayrıca dikkate alınır.
- EveryCafe gelir kartları gerçek salt-okunur kaynaktan beslenir; KafePin doğrudan satış yalnız KafePin kaynağından gelir.
- Finans kartları, Telegram, Monitor ve raporlar aynı kaynak mantığıyla tutarlı olmalıdır.
- Aynı EveryCafe geliri farklı bileşenlerden ikinci kez ciroya eklenmez.

## 8. 20:00 işletme günü kuralı

- İşletme günü sınırı **20:00**.
- 20:00 öncesi gelir kapanan işletme gününe aittir.
- 20:00 sonrası gelir yeni işletme gününe aittir.
- Devreden masa varsa yeni güne ait bölüm ayrıca `20:00 Devir Geliri` olarak gösterilebilir; bu değer ciroya ikinci kez eklenmez.
- Devir yoksa yeni işletme günü 0 TL'dan başlar.
- 20:02 otomatik FULL yedek ve 20:08 sağlık raporu cron kaçarsa açılışta catch-up ile tamamlanır.

## 9. Sistem Sağlığı ve denetim

- İlk kontrol noktası **Sistem Sağlığı** ekranıdır.
- Finans Tutarlılığı, 20:00 Gün Devri, Otomatik Yedek, Anomali Denetimi, DB, Telegram ve diğer bağlantılar görünür olmalıdır.
- Güvenli Self-Test gerçek satış/finans kayıtlarını değiştirmeden formül ve DB kontrollerini çalıştırır.
- Entegrasyon Günlüğü finans ve EveryCafe aktarım/audit ayrıntıları için kullanılır; gereksiz şekilde Canlı Sistem Günlüğü ile aynı kayıtlar çoğaltılmaz.

## 10. Canlı Sistem Günlüğü – takip kuralı

- **KafePin'deki anlamlı tüm operasyonel hareketler Canlı Sistem Günlüğü'ne yazılır.** Amaç bir sorunda olay sırasını tek ekrandan geriye doğru takip edebilmektir.
- Masa açılması/kapanması, EveryCafe kapanış algısı, yeni müşteriye hazırlama, session finalize/temizlik, spin verilmesi ve sayaç sıfırlama, admin müdahaleleri, ücretsiz kapanış, gün sonu/devir, yedek, güncelleme/restart, finans düzeltmesi, alarm/anomali ve önemli entegrasyon sonuçları günlükte görünmelidir.
- Kayıt mümkün olduğunda `masa + olay + sonuç` biçiminde anlaşılır yazılmalıdır; örneğin `Masa 20 • EveryCafe kapandı • session/spin/runtime temizlendi • yeni müşteriye hazır`.
- Hata veya başarısız işlem yalnız hata mesajını değil, mümkünse hangi adımda kaldığını da belirtmelidir.
- Aynı saniyede tekrar eden ping/heartbeat gibi yüksek frekanslı teknik olaylar günlüğü boğmamalıdır; yalnız durum değişimi veya anlamlı sonuç olduğunda kayıt oluşturulur.
- Canlı Sistem Günlüğü operasyonel takip içindir; Entegrasyon Günlüğü finans/audit ayrıntısı için ayrı tutulabilir.

## 11. Sürüm notu zorunluluğu

- **Sürüm notu olmadan paket yayınlanmaz.**
- Her güncellemede en az şu bilgiler yazılır:
  - Sürüm numarası ve tarih
  - Neler eklendi
  - Neler düzeltildi
  - Değişen eski davranışlar
  - Finans / EveryCafe etkisi
  - Test edilen senaryolar ve sonuçları
  - EveryCafe DB read-only kontrol sonucu
  - Önceki FINAL STABLE referansı
  - Kümülatif güncelleme bilgisi
  - Varsa bilinen sınırlamalar
- Paket içi `kafepin-pro-version.json` ve `update.json`, GitHub `latest.json` ve README güncel sürüm bilgisini doğru taşımalıdır.
- **Yönetim panelindeki “KafePin Pro Sürüm Notları” ekranında yeni sürümün ayrıntılı kartının gerçekten göründüğü paket testinde doğrulanır.**

## 12. Paketleme ve test yaklaşımı

- Kilitli stable sürüm yerinde değiştirilmez.
- Yeni değişiklikler bir sonraki sürüm numarasıyla çıkarılır.
- Gereksiz çalışan kodlara dokunulmaz; değişiklikler mümkün olduğunca hedefli yapılır.
- Paketlemeden önce Node/HTML JS syntax, ZIP bütünlüğü, finans formülleri, spin tarifeleri, **45 dakika yaşam döngüsü**, read-only EveryCafe erişimleri, 20:00 gün sınırı, sürüm metadata'sı ve Sürüm Notları ekranı kontrol edilir.
- Ana UI/Monitor tema ve kart düzeninin istemeden değişmediği ayrıca kontrol edilir.
- Test sonucu kullanıcıya paketlemeden önce açıklanır; kullanıcı isterse ondan sonra paketlenir.

## 13. Yeni kafe PRO klasör düzeni

- Yeni kafe / temiz kurulum paketlerinde KafePin ana çekirdeği **`C:\KafePin\`** altında kalır.
- Bağımsız PRO bileşenleri yeni kurulumlarda tek ve derli toplu bir kök altında toplanır: **`C:\KafePinPro\`**.
- Hedef klasör yapısı:
  - `C:\KafePinPro\MP3BotPRO\`
  - `C:\KafePinPro\YaziciPRO\`
  - `C:\KafePinPro\TeknikServisPRO\`
  - `C:\KafePinPro\ClientYonetimPRO\`
- Bu bileşenler aynı kök altında bulunsa da **servis/proses, config, log, runtime, güncelleme ve veri sınırları bağımsız kalır**; ortak DB/session/runtime oluşturulmaz.
- Yeni kafe ZIP'i hazırlanırken installer, servis `ImagePath`/çalıştırma yolu, başlatıcılar, updater, yeniden kurulum/onarım akışı, kısayollar ve mutlak yol kullanan config/scriptler yeni `C:\KafePinPro\...` düzenine göre güncellenir ve test edilir.
- Mevcut çalışan kafeler sırf klasör düzeni için zorla taşınmaz. Eski yollar legacy kurulum olarak çalışmaya devam edebilir; taşıma ancak ayrı bir migration/onarım planı ve kullanıcı onayıyla yapılır.
- Yeni kurulum paketi eski bir kurulum tespit ederse veri/config kaybına yol açmadan legacy yolu korumalı veya kontrollü migration sunmalıdır; sessizce dosya silme/taşıma yapılmaz.
- Bu klasör düzeni **yalnız paketleme/kurulum organizasyonudur**; KafePin çekirdeği ile PRO servislerinin teknik izolasyon kurallarını gevşetmez.

## 14. v3.1.64 FINAL Admin ve PRO servis kilidi

- Admin kartları dört anlamlı panelde tekil tutulur; aynı özgün finans kartı farklı panellerde kopyalanmaz.
- Toplam Varlık, nakit/banka/POS, Bankaya Geçecek Kart, şahsi kart borcu ve başlangıç bakiyesi yalnız `Anlık Finans` panelindedir.
- 20:00–20:00 Kafe Günü ciro, gider, kart komisyonu ve net sonuç kartları yalnız `Kasa & Muhasebe` panelindedir.
- `[hidden]` kaynak kart grupları CSS tarafından yeniden görünür yapılamaz; kart satırları ekran genişliğini boşluksuz doldurur.
- `PRO Servisleri` komutu MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO ve Client Yönetim PRO süreçlerini gerçekten yeniden başlatır; KafePin çekirdek sunucusu ile WhatsApp/Telegram oturumlarına dokunmaz.
- Bu maddeler `dev/v3164-final/verify_v3164.py` ile paket seviyesinde doğrulanmadan yeni sürüm yayınlanmaz.

## 15. Yeni kafe kurulumundan sonra STABLE eşitleme kuralı

### Seçimli bileşen tercihi — mevcut kafe koruması

- MP3 Bot PRO, Yazıcı PRO, Teknik Servis PRO, Client Yönetim PRO, Çark ve EveryCafe ilk yeni-kafe kurulumunda açıkça seçilir.
- Sonraki STABLE güncellemeleri mevcut kafedeki seçilmiş/kurulu bileşeni gizlemez, kaldırmaz, devre dışı bırakmaz veya varsayılan seçime döndürmez.
- Eski saha kurulumlarında seçim kaydı eksikse gerçek kurulu bileşen klasörü/servisi ve EveryCafe'nin varsayılan salt-okunur veri kaynağı güvenli varlık kanıtıdır; görünürlük bunlara göre korunur.
- Yeni kafede seçilmemiş bileşenin klasörü/servisi yoksa görünmez kalır. Sonradan ekleme yalnız güvenli PRO bileşen kurulum/onarım akışından yapılır.
- Bu tercih koruması müşteri verisi, PRO ayarları, favoriler, yazıcı/tarayıcı seçimi, Çark yaşam döngüsü, masa/IP yapılandırması veya EveryCafe DB üzerinde değişiklik yapmaz.

- Yeni kafe paketi önce kendi içindeki doğrulanmış çevrimdış FINAL / STABLE tabanı kurar.
- Temel kurulum tamamlandıktan sonra yalnız GitHub `latest.json` **STABLE** kanalı okunur. `latest-test.json` veya TEST sürümleri yeni kafeye otomatik kurulmaz.
- `latest.json` sürümü kurulum tabanından daha yeniyse ara sürümler tek tek kurulmadan doğrudan en yeni kümülatif STABLE sürüme geçilir. Daha yeni STABLE yoksa paket içindeki sürüm korunur.
- Sonraki kümülatif güncellemeler yeni kafe kurulumunda alınan yerel kararları silmez veya varsayılana döndürmez: EveryCafe kullanımı ve salt-okunur DB yolu, masa/IP ayarları, yedek yolu, Telegram/mesajlaşma oturumları, seçili PRO bileşenleri, kafe logosu ve bileşenlere ait config/veri korunur.
- EveryCafe seçilmediyse EveryCafe Senkron, Geçmiş Aktarım, Entegrasyon Günlüğü, Admin EveryCafe paneli ve Client Yönetim PRO gösterilmez. EveryCafe seçildiyse mevcut salt-okunur senkronizasyon yapısı tam olarak çalışmaya devam eder.
- Client kurulumunda Çark seçildiyse ping bileşeni ile Çark kısayolu birlikte kurulur; Çark seçilmediyse yalnız ping bileşeni kurulur.
- Her yeni STABLE paket, yeni kafe tabanından doğrudan o sürüme eşitleme ve yukarıdaki yerel tercihleri koruma senaryosuyla test edilmeden `latest.json` kanalına yayınlanmaz.
