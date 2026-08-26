# KafePin Pro v3.1.93 — KÜMÜLATİF STABLE KİLİDİ

Tarih: 25 Ağustos 2026  
Önceki STABLE: v3.1.92  
Yeni-kafe tabanı: v3.1.64 FINAL

## Kilitlenen davranış

- Kafe & Çark, EveryCafe, Anlık Finans ve Kasa & Muhasebe, son açık paneli ve kaydırma yerini kullanıcı geri dönene kadar korur.
- Monitor TV / Chrome %175 görünümünde kart metinlerini uzaktan okunur öncelikle ölçekler; yalnız taşan kartın metni sığacak kadar azaltılır.
- EveryCafe kapanışında ücretsiz masa kartı anında kalkar. Süresiz masa son gerçek fiyatıyla 30 saniye, süreli masa son gerçek fiyatıyla 40 saniye görünür; yeni bir “hesap kapandı” kartı oluşturulmaz.
- Görsel kapanış beklemesi KafePin session/runtime/spin/finans temizliğini ertelemez. EveryCafe açık/kapalı otoritesi ve `OPEN_READONLY` erişimi korunur.

## Korunan kapsam

- MP3/Winamp, USB MP3-Film-Oyun, PRO modülleri, finans, çarkın 45 dakika yaşam döngüsü, Telegram, WhatsApp, 20:00 işletme günü ve v3.1.92 güvenli güncelleme kurtarma akışı korunur.
- Paket, çalışan masaüstü EXE/DLL dosyasını doğrudan taşımaz. Kaynak/ikon güvenli masaüstü kurulum akışı tarafından derlenir; dosya kilidiyle yarım güncelleme oluşmaz.

## Doğrulama

- `dev/v3193-stable/verify_v3193_monitor_stable.py` ZIP CRC, metadata/SHA, korunmuş kritik payloadlar, iç PRO ZIP CRC’leri, EveryCafe read-only sözleşmesi, monitor ve yönetim işaretçilerini doğrular.
- Canlı masa kapatma testi yapılmaz; müşteri hesabını etkilememek için EveryCafe kapanış davranışı kaynak/işaretçi ve statik test ile doğrulanır.
