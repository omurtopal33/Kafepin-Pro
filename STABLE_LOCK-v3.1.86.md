# KafePin Pro v3.1.86 STABLE KİLİDİ

Tarih: 2026-08-24
Kanal: STABLE
Tip: Kümülatif saha güncellemesi

## Dağıtım düzeni

- Yeni kafe için yeni bir kurulum ZIP'i üretilmez.
- Kilitli yeni-kafe çevrimdışı tabanı `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` olarak korunur.
- Yeni kafe v3.1.64 FINAL ile kurulur; internet erişimi olduğunda yalnız `latest.json` STABLE kanalından v3.1.86 veya daha yeni kümülatif STABLE sürüme tek adımda yükselir.
- Ara update sürümlerinin tek tek kurulması gerekmez.
- v3.1.86 bundan sonraki geliştirmelerin saha STABLE referansıdır; sonraki değişiklikler yeni sürüm numarasıyla ve bu davranışlar korunarak çıkar.

## Kilitli çalışan davranışlar

- MP3 Bot PRO fiziksel Delete akışı ve v2.34.67 exact payload/version eşitlemesi korunur.
- MP3 PRO: Yukarı/Aşağı yalnız listede gezinir; `F` favori işlevini korur; `Alt+F` filtre alanına odaklanır.
- Genel KafePin Pro klavye standardı korunur.
- Her KafePin Pro güncellemesinden sonra uygulama yeniden başlatılır ve health-check tamamlanmadan güncelleme başarılı sayılmaz.
- USB MP3 / Film / Oyun fiyat ve ayarlarının kalıcılığı korunur.
- Çalıştığı doğrulanan bir özellik sonraki hedefli güncellemede değiştirilmez; yalnız istenen bölüm değiştirilir.

## Çark / EveryCafe promosyon kuralı

- Bu eşleştirme yalnız çarktan çıkan **hediye süre** ödülleri için çalışır.
- Masa kapanınca onaylanan çark hediye süresi ile EveryCafe'den gelen bilet geliri eşleşirse kayıt normal satış geliri değildir.
- Eşleşen hareket `Promosyon / Çark Hediyesi` olarak sınıflandırılır ve normal gelir toplamına eklenmez.
- Eşleşmeyen EveryCafe bilet hareketi gerçek bilet satışı olarak normal gelirde kalır.
- İçecek/atıştırmalık gibi çark ödülleri bu bilet eşleştirmesine girmez.
- EveryCafe veritabanı her durumda salt okunurdur; KafePin EveryCafe DB'ye yazmaz.

## Finans ve ana yapı kilidi

- Mevcut 20:00 işletme günü, finans, session, spin yaşam döngüsü, EveryCafe read-only güvenliği ve Admin/Monitor görsel düzeni onaysız değiştirilmez.
- Promosyon sınıflandırması gerçek satışı gizleyemez; yalnız onaylı çark hediye süre kaydıyla tekil olarak eşleşen bilet hareketini promosyon sayar.
- Aynı EveryCafe hareketi ikinci kez gelire veya promosyona yazılmaz.

## Repo temizliği kuralı

- Aktif dağıtım kökünde yalnız güncel STABLE update paketi tutulması hedeflenir.
- Yeni-kafe FINAL v3.1.64 ve gerekli Client / kurulum referansları silinmez.
- Eski ara sunucu update ZIP/SHA ve onların eski release notları, yeni STABLE GitHub'a başarıyla yerleşip `latest.json` doğrulandıktan sonra temizlenebilir.
- TEST kanalına ait geçici dosyalar aktif STABLE dağıtım kaynağı olarak kullanılmaz.

Bu dosya v3.1.86 için değişmez saha kilididir.
