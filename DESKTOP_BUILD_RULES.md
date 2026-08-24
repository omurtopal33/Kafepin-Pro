# KafePin Pro Masaustu Kabuk Derleme Kurali

Bu dosya masaustu kabugu (`desktop-app/KafePinProDesktop.cs`) ve guncelleme sonrasi kabuk aktivasyonu icin zorunlu yayin kapisidir.

## Degismez kural

- `desktop-app/KafePinProDesktop.cs` degisiyorsa paket, sahada kullanilan .NET Framework `csc.exe` dil seviyesiyle uyumluluk kontrolunden gecmeden TEST/STABLE olarak verilmez.
- Yeni kod eski derleyicinin desteklemedigi C# sozdizimi kullanamaz. Ozellikle discard bicimi `_ = Task`, yeni pattern/discard sozdizimi ve saha derleyicisinin kabul etmedigi kisayollar yasaktir.
- Derleme hatasi varsa eski `KafePin Pro.exe` korunur; ancak guncelleme basarili sayilmaz.
- Kabuk degisiyorsa akisin zorunlu sirasi: kaynak/payload esitleme -> masaustu EXE derleme -> yeni EXE hash/surum dogrulama -> aktif Windows kullanici oturumunda yeniden baslatma -> calisan EXE yolunu dogrulama.
- Kabuk yenilenmesi gereken surumde eski EXE acik kalirsa bu basari sayilmaz.
- PRO payload degismisse ilgili bagimsiz PRO servis/bilesen yenilenir; tum PRO bilesenleri `C:\KafePinPro\` altinda kendi proses/config/log/runtime sinirlarini korur.
- Post-update lock yalniz gercek aktivasyon tamamlandiginda temizlenir; yarim kalmis/stale lock ayrica guvenli kuralla temizlenebilir.

## Paket oncesi zorunlu kontroller

1. `KafePinProDesktop.cs` icindeki yeni degisikliklerin .NET Framework saha derleyicisiyle uyumlu oldugunu kontrol et.
2. Bilinen uyumsuz kaliplari tara; en az `_ =` discard kalibi sifir sonuc vermeli.
3. Desktop setup scriptinin iki `csc.exe` yolunu ve gercek derleme cikisini kontrol ettigini dogrula.
4. Kabuk versiyon manifesti, kaynak hash'i ve derlenmis EXE hash'i uyusmadan post-update basarili sayilmasin.
5. Kabuk degisiyorsa yeniden baslatma ve calisan EXE path dogrulamasi zorunlu olsun.
6. Node/HTML/JSON/ZIP kontrollerine ek olarak bu desktop compile gate sonucu surum notuna yazilsin.

Bu kural CV Olustur PRO ile ortaya cikan saha derleme regresyonlarindan sonra kalici hale getirilmistir.
