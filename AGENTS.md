# AGENTS.md — KafePin Pro Codex Talimatları

Bu repoda herhangi bir kod değişikliği yapmadan önce aşağıdaki dosyaları sırayla oku:

1. `KAFEPIN_RULES.md` — değişmez proje kuralları ve ana işleyiş.
2. `CODEX_HANDOFF.md` — güncel proje durumu, sürüm ilişkileri ve devam noktası.
3. `README.md` ve `latest.json` — dağıtım/stable durumu.
4. MP3 Bot ile ilgili herhangi bir işte ayrıca `MP3_BOT_RULES.md` — KafePin/MP3 kesin izolasyon sınırları ve v2.26 fonksiyonel referansı.

## Zorunlu çalışma şekli

- Kullanıcı bir değişiklik istediğinde **hemen kodlama yapma**. Önce değişikliğin mevcut ana yapıya etkisini değerlendir.
- `server.js`, finans, spin, EveryCafe, 20:00 gün devri, kapanış/temizlik, güncelleme/yedek, güvenlik veya Monitor/Admin tema-yapısını etkileyen bir değişiklik varsa önce kullanıcıya neyin değişeceğini ve riskini açıkla, **açık onay al**, sonra kodla.
- Kullanıcı onayı olmadan çalışan ana yapıyı refactor etme, yeniden tasarlama veya sadeleştirme amacıyla değiştirme.
- Gereksiz dosyalara dokunma. Hedefli ve küçük değişiklik tercih et.
- Monitor/Admin/yönetim arayüzünün tema, renk, kart yerleşimi ve mevcut görünümünü koru. Görsel değişiklik ayrıca onay gerektirir.

## Değişmez teknik kurallar

- EveryCafe veritabanı **yalnız okunur**. Tüm bağlantılar `sqlite3.OPEN_READONLY` olmalı. EveryCafe DB'ye hiçbir `INSERT/UPDATE/DELETE/CREATE/ALTER/DROP` yapılmaz.
- EveryCafe entegrasyonu açıkken masa açık/kapalı otoritesi EveryCafe'dir. Ping yalnız bağlantı bilgisidir.
- EveryCafe masa hesabı açıksa PC restart/ping kesintisi müşteriyi kapatmaz.
- EveryCafe masa hesabı kapandıysa ücretli/ücretsiz fark etmeden KafePin eski müşteriyi temizler ve masayı yeni müşteriye hazırlar.
- Çark 45 dakika yaşam döngüsü `KAFEPIN_RULES.md` içindeki şekilde aynen korunur: yeni müşteri sayfayı ilk kez açmadan sayaç başlamaz; ilk gerçek açılışta 45:00 başlar; pencere kapansa da süre gerçek zamanla ilerler; spin sonrası yeniden 45:00; yeni müşteriye eski süre/hak devretmez.
- Genel Ciro = EveryCafe Gerçek Gelir + KafePin Doğrudan Satış. Çark maliyeti cirodan düşülmez.
- İşletme günü sınırı 20:00'dır; 20:00 sonrası yeni işletme günüdür.
- Canlı Sistem Günlüğü anlamlı operasyonel hareketlerin ana teknik takip yeridir. Ping/heartbeat spam edilmez.
- Her sürümde ayrıntılı sürüm notu zorunludur ve Yönetim panelindeki Sürüm Notları ekranında görünürlüğü test edilir.
- **MP3 Bot ile KafePin çekirdeği birbirinden bağımsızdır.** MP3 Bot KafePin DB/session/spin/finans/EveryCafe/gün sonu/Telegram/runtime yapısına erişmez; KafePin Node prosesine MP3/Python/yt-dlp/FFmpeg iş mantığı gömülmez. Ayrıntılar `MP3_BOT_RULES.md` içindedir.

## Sürüm disiplini

- **v3.1.60 kilitli yeni-kafe FINAL tabanıdır; yerinde değiştirilmez.**
- **v3.1.64 kilitli güncel saha FINAL / STABLE referansıdır; kart mimarisi ve PRO servis davranışı yerinde değiştirilmez.**
- Bundan sonraki değişiklikler v3.1.65+ yeni kümülatif sürüm numarasıyla, doğrudan v3.1.60 tabanından ve v3.1.64 saha davranışları korunarak çıkar.
- v3.1.60 tarihsel bootstrap paketi yerinde değiştirilmez. Güncel yeni-kafe dağıtımı `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` olup v3.1.64'ü çevrimdışı doğrudan kurar; ardından yalnız daha yeni STABLE güncellemeler uygulanır.
- Paketlemeden önce syntax, finans formülleri, spin tarifeleri, 45 dakika yaşam döngüsü, EveryCafe read-only, 20:00 sınırı, UI tema bütünlüğü, sürüm metadata'sı ve Sürüm Notları ekranı test edilir.
- Test sonuçlarını kullanıcıya açıkla; kullanıcı paketleme istediyse paketle.

## v3.1.64 FINAL regresyon kilidi

- `Kafe & Çark`, `EveryCafe`, `Anlık Finans` ve `Kasa & Muhasebe` kart grupları `dev/v3164-final/verify_v3164.py` doğrulamasını geçmeden yayın yapılamaz.
- Toplam Varlık ve Bankaya Geçecek Kart yalnız Anlık Finans'ta; 20:00–20:00 Kafe Günü kartları yalnız Kasa & Muhasebe'de bulunur.
- Gizli eski kaynak kart grupları görünemez ve otomatik kart dizilimi satır sonunda boş alan bırakamaz.
- `PRO Servisleri` düğmesi yalnız durum raporu vermez; dört bağımsız PRO servisini gerçekten durdurup yeniden başlatır. KafePin çekirdek Node süreci ile WhatsApp/Telegram WebView2 profilleri bu işlemden etkilenmez.
- Yeni kafe kurulumu çevrimdış tabandan sonra yalnız daha yeni `latest.json` STABLE sürümüne tek adımda eşitlenir; TEST kanalına geçmez. EveryCafe/PRO/Client/Çark/logo ve yerel config tercihlerini koruma kuralları `KAFEPIN_RULES.md` 15. bölümdeki regresyon testleriyle zorunludur.

Bir kural ile kullanıcı isteği çelişirse kod yazmadan önce çelişkiyi kullanıcıya açıkça bildir ve onay iste.
