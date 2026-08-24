# KafePin Pro Güncelleme Merkezi

## Güncel sürüm düzeni

- **v3.1.86 STABLE:** Güncel kümülatif saha sürümüdür ve bundan sonraki geliştirmelerin davranış referansıdır.
- **Yeni kafe dağıtımı değişmez:** `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` çevrimdışı kurulum tabanıdır. Her STABLE sürüm için yeni bir yeni-kafe ZIP'i üretilmez.
- Yeni kafe v3.1.64 FINAL ile kurulur; internet varsa yalnız `latest.json` içindeki daha yeni STABLE sürümü tek adımda alır.
- Ara sürümlerin tek tek kurulması gerekmez.
- TEST paketleri STABLE dağıtım kaynağı değildir; `latest.json` yalnız güncel STABLE güncellemeyi gösterir.

## Yeni Kafe kurulumu

1. `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` içindeki `KURULUMU_BASLAT.cmd` çalıştırılır.
2. Kurucu internet olmasa da v3.1.64 FINAL tabanını kurabilir.
3. İnternet varsa `latest.json` kontrol edilir; daha yeni STABLE varsa doğrudan güncel kümülatif STABLE'a yükseltilir.
4. Ara update sürümleri kurulmaz.

PRO klasör düzeni korunur:

- MP3 Bot PRO: `C:\KafePinPro\MP3BotPRO`
- Yazıcı PRO: `C:\KafePinPro\YaziciPRO`
- Teknik Servis PRO: `C:\KafePinPro\TeknikServisPRO`
- Client Yönetim PRO: `C:\KafePinPro\ClientYonetimPRO`

## v3.1.86 STABLE kilitleri

- Önceki onaylı kümülatif düzeltmeler korunur.
- MP3 Bot PRO fiziksel Delete ve v2.34.67 exact payload/version davranışı korunur.
- MP3 PRO klavye: Yukarı/Aşağı yalnız listede gezinir; `F` favori olarak kalır; `Alt+F` filtre alanına gider.
- Genel klavye standardı ve güncelleme sonrası KafePin Pro restart/health-check akışı korunur.
- USB MP3 / Film / Oyun fiyat ve ayar kalıcılığı korunur.
- Çarktan çıkan **hediye süre**, masa kapanışında onaylandıktan sonra EveryCafe bilet geliriyle tekil eşleşirse `Promosyon / Çark Hediyesi` olarak sınıflandırılır ve normal gelire eklenmez.
- Eşleşmeyen EveryCafe bilet hareketi gerçek satış olarak normal gelirde kalır.
- İçecek/atıştırmalık ödülleri hediye-süre bilet eşleştirmesine girmez.

## Güvenlik ve ana yapı

- EveryCafe veritabanı yalnız `sqlite3.OPEN_READONLY` ile okunur; EveryCafe'ye yazma yapılmaz.
- KafePin session, spin, 45 dakika yaşam döngüsü, 20:00 işletme günü, Telegram ve ana finans davranışları onaysız değiştirilmez.
- Monitor/Admin tema ve kart yapısı onaysız değiştirilmez.
- Aynı EveryCafe hareketi ikinci kez gelir veya promosyon olarak kaydedilmez.

## Depo düzeni

Korunacak temel dağıtımlar:

- `KafePin-Pro-Yeni-Kafe-FINAL-v3.1.64.zip` — yeni kafe çevrimdışı tabanı.
- `KafePin-Client-v3.1.64.zip` — eşleşen Client dağıtımı.
- Güncel `KafePin-Pro-Update-v3.1.86.zip` — aktif STABLE kümülatif update.

Eski ara sunucu update ZIP/SHA ve eski ara release notları, v3.1.86 ZIP GitHub'a başarıyla yerleşip `latest.json` doğrulandıktan sonra aktif kökten temizlenir. Yeni-kafe FINAL v3.1.64 ve gerekli Client/kurulum referansları korunur.

Ayrıntılı değişmez saha kilidi: `STABLE_LOCK-v3.1.86.md`.
