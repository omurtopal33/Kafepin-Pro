# KafePin Pro — Güncel Devir Notu

## Kilitli referanslar

- **v3.1.60 FINAL / STABLE** değişmeyen yeni-kafe kurulum tabanıdır.
- **v3.1.64 FINAL / STABLE** onaylanan güncel saha davranışının kilitli kümülatif güncellemesidir.
- Yeni kafeye `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` verilir; paket v3.1.64'ü çevrimdışı doğrudan kurar ve ardından yalnız `latest.json` içindeki daha yeni kümülatif STABLE sürümü uygular.
- v3.1.60 tarihsel bootstrap paketi yerinde değiştirilmez.
- Sonraki değişiklikler v3.1.65+ olur; v3.1.64 yerinde değiştirilmez.

## v3.1.64 kilidi

- Admin kart mimarisi dört panelde tekildir ve boşluksuz otomatik dizilir.
- Toplam Varlık ve Bankaya Geçecek Kart yalnız Anlık Finans'tadır.
- 20:00–20:00 Kafe Günü kartları yalnız Kasa & Muhasebe'dedir.
- Gizli eski kart grupları görünmez.
- PRO Servisleri düğmesi MP3, Yazıcı, Teknik Servis ve Client Yönetim servislerini gerçekten yeniden başlatır.
- KafePin çekirdek Node süreci ve WhatsApp/Telegram WebView2 oturumları yeniden başlatma kapsamı dışındadır.
- Paket kilidi: `dev/v3164-final/verify_v3164.py`.
- Yeni-kafe/Client kilidi: `dev/v3164-final/verify_new_cafe_v3164.py`.

## Korunan çekirdek

- `server.js`, finans formülleri, spin/session, EveryCafe salt-okunur erişimi, Telegram ve 20:00 gün sonu v3.1.63 ile byte-for-byte korunmuştur.
- EveryCafe DB'ye yazılmaz.
- Monitor ve Yönetim arayüzleri değiştirilmemiştir.

## PRO klasörleri

Sahada doğrulanan bağımsız klasörler:

- `C:\KafePinPro\MP3BotPRO`
- `C:\KafePinPro\YaziciPRO`
- `C:\KafePinPro\TeknikServisPRO`
- `C:\KafePinPro\ClientYonetimPRO`

Bu klasörler aynı üst dizinde olsa da proses, config, veri ve runtime sınırları bağımsızdır.

## Yeni kafe sonraki STABLE eşitleme kilidi

- Yeni kafe paketi önce kendi çevrimdış tabanını kurar, sonra yalnız daha yeni `latest.json` STABLE sürümü varsa doğrudan o kümülatif sürüme geçer.
- EveryCafe yoksa masaüstü ve Admin EveryCafe alanları ile Client Yönetim PRO gizlidir; varsa salt-okunur senkronizasyon aynen aktiftir.
- Yerel EveryCafe yolu, masa/IP, yedek, PRO seçimleri, mesajlaşma oturumları, logo ve bileşen config/verileri güncellemeyle sıfırlanmaz.
- Client tarafında Çark seçimi ping + kısayol; Çark yoksa yalnız ping kuralı korunur.
