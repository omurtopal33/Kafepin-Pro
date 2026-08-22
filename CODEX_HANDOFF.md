# KafePin Pro — Güncel Devir Notu

## Kilitli referanslar

- **v3.1.60 FINAL / STABLE** değişmeyen yeni-kafe kurulum tabanıdır.
- **v3.1.64 FINAL / STABLE** onaylanan güncel saha davranışının kilitli kümülatif güncellemesidir.
- Yeni kafede v3.1.60 temel kurulur ve ardından yalnız `latest.json` içindeki en güncel kümülatif STABLE uygulanır.
- Sonraki değişiklikler v3.1.65+ olur; v3.1.64 yerinde değiştirilmez.

## v3.1.64 kilidi

- Admin kart mimarisi dört panelde tekildir ve boşluksuz otomatik dizilir.
- Toplam Varlık ve Bankaya Geçecek Kart yalnız Anlık Finans'tadır.
- 20:00–20:00 Kafe Günü kartları yalnız Kasa & Muhasebe'dedir.
- Gizli eski kart grupları görünmez.
- PRO Servisleri düğmesi MP3, Yazıcı, Teknik Servis ve Client Yönetim servislerini gerçekten yeniden başlatır.
- KafePin çekirdek Node süreci ve WhatsApp/Telegram WebView2 oturumları yeniden başlatma kapsamı dışındadır.
- Paket kilidi: `dev/v3164-final/verify_v3164.py`.

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
