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

- **v3.1.45 kilitli FINAL STABLE referansıdır; yerinde değiştirilmez.**
- v3.1.44, v3.1.45'e temel olan sahada/testte doğrulanmış önceki geliştirme sürümüdür.
- Bundan sonraki değişiklikler **v3.1.46+** yeni kümülatif sürüm numarasıyla çıkar.
- Yeni kafe kurulumu v3.1.29 STABLE taban + doğrudan en güncel kümülatif stable update şeklindedir.
- Paketlemeden önce syntax, finans formülleri, spin tarifeleri, 45 dakika yaşam döngüsü, EveryCafe read-only, 20:00 sınırı, UI tema bütünlüğü, sürüm metadata'sı ve Sürüm Notları ekranı test edilir.
- Test sonuçlarını kullanıcıya açıkla; kullanıcı paketleme istediyse paketle.

Bir kural ile kullanıcı isteği çelişirse kod yazmadan önce çelişkiyi kullanıcıya açıkça bildir ve onay iste.
