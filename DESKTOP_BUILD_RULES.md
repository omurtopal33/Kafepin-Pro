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

## Sessiz arka plan calisma standardi

- Guncelleme, post-update aktivasyon, PRO servis yenileme, Desktop Bridge hazirlama, component sync ve onarim akislari kullaniciya PowerShell/CMD penceresi acip kapatmaz.
- Bu teknik islemlerde `powershell.exe` ve `cmd.exe` `CreateNoWindow/windowsHide/WindowStyle Hidden` esdegerleriyle arka planda calistirilir.
- PowerShell icinden ikinci bir PowerShell veya CMD baslatiliyorsa alt proses de ayrica Hidden/NoWindow olmak zorundadir; yalniz ust prosesin gizli olmasina guvenilmez.
- Kullanici girdisi isteyen yeni-kafe sihirbazlari bu kuralin disindadir; onlar ancak kullanici tarafindan baslatildiginda gorunur olabilir.
- Sessiz calisma hata bilgisini yutmaz. Her basarisiz adim `logs/update-supervisor.log` veya ilgili bilesen loguna ayrintili yazilir; anlamli sonuc Canli Sistem Gunlugu'ne kisa ve okunur bicimde aktarilir.
- Guncelleme basarili sayilmadan once servis/kabuk health-check sonucu loglanir. Hata varsa gorunur terminal acmak yerine panelde hata ozeti ve log ayrintisi kullanilir.

## Paket oncesi zorunlu kontroller

1. `KafePinProDesktop.cs` icindeki yeni degisikliklerin .NET Framework saha derleyicisiyle uyumlu oldugunu kontrol et.
2. Bilinen uyumsuz kaliplari tara; en az `_ =` discard kalibi sifir sonuc vermeli.
3. Desktop setup scriptinin iki `csc.exe` yolunu ve gercek derleme cikisini kontrol ettigini dogrula.
4. Kabuk versiyon manifesti, kaynak hash'i ve derlenmis EXE hash'i uyusmadan post-update basarili sayilmasin.
5. Kabuk degisiyorsa yeniden baslatma ve calisan EXE path dogrulamasi zorunlu olsun.
6. Update/runtime kodunda gorunur PowerShell/CMD spawn kalibi kalmadigini statik olarak tara; kullanici-etkilesimli ilk kurulum sihirbazlari haric sifir gorunur teknik spawn hedeflenir.
7. Node/HTML/JSON/ZIP kontrollerine ek olarak desktop compile gate ve silent-background gate sonucu surum notuna yazilsin.

Bu kural CV Olustur PRO ile ortaya cikan saha derleme ve gorunur terminal regresyonlarindan sonra kalici hale getirilmistir.
