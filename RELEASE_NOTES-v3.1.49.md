# KafePin Pro v3.1.49 — STABLE / KÜMÜLATİF

Tarih: 20.08.2026  
Temel: v3.1.29 STABLE  
Dağıtım: Ara paket gerektirmeden doğrudan v3.1.49

## Yeni Kafe kurulumu

Ana Sunucu kurulumu sonunda üç bağımsız bileşen için seçim gösterilir: MP3 Bot PRO, Yazıcı PRO ve Teknik Servis PRO. Client kurulumunun ping, çark ve API uyumluluk akışı aynen korunur.

## MP3 Bot PRO

- Dinleme Modu, Web Audio/EQ, shuffle ve sekme geçişinde kesintisiz ses korunur.
- Winamp Modu ve Favori Listem bağımsız çalışır.
- MP3 motoru yalnız `127.0.0.1:17890` loopback hizmetidir; KafePin DB’sine bağlanmaz.

## Yazıcı PRO

- Kimlik fotokopisi, normal/çoklu tarama, resim yerleşimi ve Windows yazıcı/tarayıcı seçimi korunur.
- PDF/dosya dönüştürme ile KafePin Belgeler klasörü özellikleri korunur.
- Yazıcı motoru yalnız `127.0.0.1:17891` loopback hizmetidir.

## Teknik Servis PRO

- Servis kaydı, KafePin logolu A4 servis fişi ve Nakit/Kart ödeme biçimi eklenir.
- Kullanıcı tahsil edilmiş servis kaydını kaydettiğinde, mevcut KafePin doğrudan satış uç noktasına tek Nakit/Kart satışı gönderilir.
- Servis kaydında satış kimliği saklandığından ikinci finans kaydı oluşturulmaz; senkronlanmış tahsilatın tutarı/ödeme şekli korunur.
- Teknik Servis motoru yalnız `127.0.0.1:17892` loopback hizmetidir.

## Finans ve EveryCafe

Tek finans etkisi, kullanıcı tarafından tahsil edilmiş Teknik Servis kaydının KafePin doğrudan satışına eklenmesidir. Genel Ciro, 20:00 işletme günü, mevcut doğrudan satışlar, spin maliyeti ve Telegram/gün sonu akışı değiştirilmez. EveryCafe salt okunurdur: `OPEN_READONLY`; INSERT/UPDATE/DELETE/CREATE/ALTER/DROP yapılmaz.

## Doğrulama

- JavaScript ve PowerShell syntax kontrolleri geçti.
- MP3, Yazıcı ve Teknik Servis Python kaynakları compile edildi.
- Seçimli bileşen paketlerinin arşiv bütünlüğü doğrulandı.
- Yazıcı PRO PDF motoru/tarayıcı-yazıcı listeleme ve Teknik Servis A4 fiş akışı sahada kontrol edildi.

Bu, kararlı kümülatif noktadır. Sonraki sürümler TEST güncellemesi olarak yayınlanacaktır.

## Kanal ayrımı

- `latest.json` yalnız STABLE kanalıdır ve v3.1.49’u gösterir.
- Gelecek v3.1.50 TEST ve sonraki test paketleri yalnız `latest-test.json` içinde duyurulur.
- Yeni Kafe kurucusu sadece STABLE `latest.json` dosyasını okuyarak v3.1.49’u kurar.
