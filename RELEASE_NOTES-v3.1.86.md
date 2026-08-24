# KafePin Pro v3.1.86 STABLE — Kümülatif Sürüm Notları

Tarih: 2026-08-24
Önceki saha STABLE referansı: v3.1.64 / dağıtım kanalı öncesi v3.1.66
Yeni saha STABLE referansı: v3.1.86

## Eklenen / kilitlenenler

- 3.1.85 test döngüsünde onaylanan güncellemeler v3.1.86 STABLE altında kümülatif olarak kilitlendi.
- MP3 PRO klavye kullanımı: Yukarı/Aşağı yalnız listede gezinir; F favori işlevini korur; Alt+F filtre alanına odaklanır.
- MP3 PRO fiziksel Delete ve v2.34.67 exact payload/version eşitlemesi korunur.
- Genel KafePin Pro klavye standardı ve güncelleme sonrası restart/health-check akışı korunur.
- USB MP3 / Film / Oyun fiyat ve ayar kalıcılığı korunur.

## Finans / EveryCafe / Çark

- Çarktan çıkan yalnız **hediye süre** ödülleri için EveryCafe bilet geliri promosyon eşleştirmesi eklendi.
- Masa kapanınca onaylanan çark hediye süresi ile EveryCafe bilet hareketi tekil eşleşirse hareket `Promosyon / Çark Hediyesi` olarak işaretlenir ve normal gelir toplamına eklenmez.
- Eşleşmeyen EveryCafe bilet hareketi normal gerçek satış geliri olarak kalır.
- İçecek/atıştırmalık gibi süre dışı çark ödülleri bu eşleştirmeye girmez.
- Aynı EveryCafe hareketi ikinci kez gelir/promosyon olarak işlenmez.
- EveryCafe DB salt okunurdur; EveryCafe tarafına yazma yapılmaz.

## Korunan ana davranışlar

- 45 dakika çark yaşam döngüsü.
- Session ve masa kapanış temizliği.
- 20:00 işletme günü.
- Admin / Monitor tema ve kart düzeni.
- Telegram ve ana finans kaynak mantığı.
- PRO servis yeniden başlatma davranışı.

## Yeni kafe dağıtımı

Yeni bir yeni-kafe ZIP'i üretilmez. `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` çevrimdışı taban olarak korunur. Kurulum internet varsa STABLE `latest.json` üzerinden v3.1.86'ya tek adımda yükselir.

## Paket doğrulaması

- Paket sürüm metadata: 3.1.86 / stable / finalStable=true.
- Kümülatif update: true.
- ZIP bütünlük testi: başarılı.
- SHA256: `305b04d6bcda166db4fd6057a76318ac0500faae16d1e2b6813c454fc55dbf9e`.
- Yeni saha kilidi: `STABLE_LOCK-v3.1.86.md`.
