# KafePin Yazıcı PRO v3.1.48 CUMULATIVE

KafePin çekirdeğinden bağımsız yerel Windows uygulamasıdır.

Bu ilk kümülatif paket; Kimlik Fotokopi, Normal Tarama, Windows cihaz seçimi,
A4 düzeni, yazdırma, isteğe bağlı kayıt ve geçici veri temizliğini birlikte içerir.

## Başlatma

İlk kullanımda `KURULUM.cmd`, sonraki kullanımlarda `START_YAZICI_PRO.cmd` çalıştırılır.
Uygulama yalnız `http://127.0.0.1:17891` adresinde çalışır.

## Modlar

- **Kimlik Fotokopi:** Ön ve arka yüz ayrı taranır; A4 üzerinde yan yana veya alt alta hazırlanır.
- **Normal Tarama:** Düz yataklı cihazlarda her sayfa tek tek eklenir; çoklu sayfa PDF üretilir.

## Gizlilik

- Normal tarama/yazdırma işleminde kalıcı arşiv oluşturulmaz.
- `TEMİZLE` geçici görüntüleri hemen siler.
- Yalnız `PDF KAYDET` veya `JPG KAYDET` seçilirse dosya `Belgeler\KafePin Belgeler` altına kaydedilir.
- Klasör yalnız kullanıcı `KLASÖRÜ AÇ` düğmesine basarsa açılır.

## Cihazlar

- Yazıcı listesi Windows'tan otomatik okunur; her kafede farklı yazıcı seçilebilir.
- Tarayıcı listesi Windows WIA kaynaklarından gelir.
- Epson L3150 için Epson Scan 2 / WIA tarayıcı sürücüsünün Windows'ta kurulu ve cihazın açık olması gerekir.
- ADF destekleyen cihazların otomatik çoklu besleme özelliği sonraki cihaz-test aşamasında etkinleştirilecektir. L3150 düz yataklı kullanımda sayfalar elle tek tek taranır.
