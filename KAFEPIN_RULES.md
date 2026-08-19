# KafePin Pro – Değişmez Proje Kuralları

Bu dosya yeni sohbetlerde ve yeni sürümlerde referans alınacak ana kuralları içerir.

## Sürüm ve kurulum kuralları

- **v3.1.43 = kilitli FINAL STABLE referans sürümüdür.** Değiştirilmez.
- v3.1.44 ve sonrası tüm geliştirmeler yeni kümülatif sürüm numarasıyla çıkar.
- Yeni kafe kurulumu: **v3.1.29 STABLE taban → doğrudan en güncel kümülatif STABLE UPDATE**.
- Ara sürümlerin tek tek kurulması gerekmez.
- Her yeni sürüm önceki tüm gerekli düzeltmeleri içerir.

## EveryCafe entegrasyonu – değişmez güvenlik kuralı

- **KafePin, EveryCafe veritabanına ASLA yazmaz.**
- EveryCafe bağlantıları yalnız `sqlite3.OPEN_READONLY` ile açılır.
- EveryCafe tarafında `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP` veya başka herhangi bir yazma işlemi yapılmaz.
- Masa, oturum, satış, ücret, ödeme ve kapanış bilgileri EveryCafe'den yalnız okunur.
- KafePin'e ait session, spin, audit, yedek, muhasebe, ayar ve temizlik işlemleri yalnız KafePin'in kendi veritabanında yapılır.
- Her sürüm testinde EveryCafe bağlantılarının tamamının read-only olduğu ayrıca doğrulanır.

## Masa açık/kapalı otoritesi

- EveryCafe entegrasyonu açıksa **masa açık/kapalı kararında tek otorite EveryCafe'dir**.
- **EveryCafe'de müşteri masa hesabı açık = müşteri devam ediyor.** Ping kesilmesi, PC donması veya PC restartı müşteriyi kapatmaz.
- **EveryCafe'de müşteri masa hesabı kapanmış = müşteri bitmiştir.** Ücretli/ücretsiz fark etmez; KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar.
- Ping yalnız PC'nin bağlantı/online bilgisidir; müşteri hesabını kapatma yetkisi yoktur.
- Eski 5 dakika / ping yoksa otomatik kapat yaklaşımı EveryCafe entegrasyonu açıkken kullanılmaz.
- EveryCafe'de kapanmış eski müşteriden sonradan ping/status/spin gelmesi eski oturumu yeniden diriltmemelidir.
- Kapanışta eski session/runtime/spin sayacı/kilitler temizlenir; yeni müşteri kendi yeni oturumu ve 45 dk çark sayacıyla başlar.
- Finans tutarı tahmin edilmez; kapanış/tahsilat EveryCafe'nin gerçek salt-okunur kaydından senkronlanır.

## Çark kuralları

- Çark bekleme süresi sabit **45 dakika**.
- İlk çark sayfası açılışında 45:00 başlar; anında spin hakkı verilmez.
- Her başarılı spin sonrası sayaç yeniden 45:00 olur.
- Mevcut 5 spin hakkı kuralı korunur.
- Yalnız Admin `Acil Hazır / force-ready` beklemeyi atlayabilir.
- EveryCafe ücretsiz/hediye süreleri çark sayacını değiştirmez.
- Spin maliyetleri merkezi ve sabittir:
  - Normal 30 dk = 25 TL
  - Normal 60 dk = 50 TL
  - VIP 30 dk = 35 TL
  - VIP 60 dk = 70 TL
  - İçecek/atıştırmalık/anahtarlık = 20 TL
- Hafta içi/hafta sonu fiyat ayrımı yoktur.
- Test Mode / 1 dakika spin kısayolu yoktur.

## Finans kuralları

- **Genel Ciro = EveryCafe Gerçek Gelir + KafePin Doğrudan Satış**.
- Çark maliyeti genel cirodan düşülmez; ayrı maliyet olarak gösterilir.
- Net işletme sonucu hesaplarında gider, kart komisyonu ve çark maliyeti ayrıca dikkate alınır.
- EveryCafe gelir kartları mümkün olduğunca gerçek salt-okunur kaynaktan beslenir.
- Finans kartları, Telegram ve monitor aynı kaynak mantığıyla tutarlı olmalıdır.

## 20:00 işletme günü kuralı

- İşletme günü sınırı **20:00**.
- 20:00 öncesi gelir kapanan işletme gününe aittir.
- 20:00 sonrası gelir yeni işletme gününe aittir.
- Devreden masa varsa yeni güne ait bölüm ayrıca `20:00 Devir Geliri` olarak gösterilebilir; bu değer ciroya ikinci kez eklenmez.
- Devir yoksa yeni işletme günü 0 TL'dan başlar.
- 20:02 otomatik FULL yedek ve 20:08 sağlık raporu cron kaçarsa açılışta catch-up ile tamamlanır.

## Sistem Sağlığı ve denetim

- İlk kontrol noktası **Sistem Sağlığı** ekranıdır.
- Finans Tutarlılığı, 20:00 Gün Devri, Otomatik Yedek, Anomali Denetimi, DB, Telegram ve diğer bağlantılar görünür olmalıdır.
- Güvenli Self-Test gerçek satış/finans kayıtlarını değiştirmeden formül ve DB kontrollerini çalıştırır.
- Entegrasyon Günlüğü finans ve EveryCafe aktarım/audit ayrıntıları için kullanılır; gereksiz şekilde Canlı Sistem Günlüğü ile aynı kayıtlar çoğaltılmaz.

## Canlı Sistem Günlüğü – takip kuralı

- **KafePin'deki anlamlı tüm operasyonel hareketler Canlı Sistem Günlüğü'ne yazılır.** Amaç bir sorunda olay sırasını tek ekrandan geriye doğru takip edebilmektir.
- Masa açılması/kapanması, EveryCafe kapanış algısı, yeni müşteriye hazırlama, session finalize/temizlik, spin verilmesi ve sayaç sıfırlama, admin müdahaleleri, ücretsiz kapanış, gün sonu/devir, yedek, güncelleme/restart, finans düzeltmesi, alarm/anomali ve önemli entegrasyon sonuçları günlükte görünmelidir.
- Kayıt mümkün olduğunda `masa + olay + sonuç` biçiminde anlaşılır yazılmalıdır; örneğin `Masa 20 • EveryCafe kapandı • session/spin/runtime temizlendi • yeni müşteriye hazır`.
- Hata veya başarısız işlem yalnız hata mesajını değil, mümkünse hangi adımda kaldığını da belirtmelidir.
- Aynı saniyede tekrar eden ping/heartbeat gibi yüksek frekanslı teknik olaylar günlüğü boğmamalıdır; yalnız durum değişimi veya anlamlı sonuç olduğunda kayıt oluşturulur.
- Canlı Sistem Günlüğü operasyonel takip içindir; Entegrasyon Günlüğü finans/audit ayrıntısı için ayrı tutulabilir.

## Sürüm notu zorunluluğu

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

## Geliştirme yaklaşımı

- Kilitli stable sürüm yerinde değiştirilmez.
- Yeni değişiklikler bir sonraki sürüm numarasıyla çıkarılır.
- Gereksiz çalışan kodlara dokunulmaz; değişiklikler mümkün olduğunca hedefli yapılır.
- Paketlemeden önce Node/HTML JS syntax, ZIP bütünlüğü, finans formülleri, spin tarifeleri, read-only EveryCafe erişimleri ve sürüm metadata'sı kontrol edilir.
