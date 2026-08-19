# KafePin Pro Update Center

Bu depo KafePin Pro guncelleme paketleri icindir.

## KILITLI / STABLE DURUM

- **v3.1.29 = STABLE FULL BASE.** Yeni kafe kurulumu ve tum kumulatif guncellemelerin guvenli tabanidir.
- **v3.1.43 = FINAL STABLE.** Finans tutarlilik denetimi, 20:00 isletme gunu devri, otomatik FULL ZIP yedek, gun sonu saglik raporu, anomali denetimi, Guvenli Self-Test, veri kaynagi rozetleri, aylik Telegram ozeti ve onceki tum onayli ozellikleri kapsayan guncel kilitli surumdur.
- v3.1.43 kumulatiftir; v3.1.29 uzerine dogrudan kurulabilir. Ara surumleri kurmak gerekmez.
- Depoda dagitim paketi olarak yalniz v3.1.29 tabani ve v3.1.43 guncel FINAL STABLE paket tutulur.

## Guncelleme guvenligi

- Kafe veritabani, token, IP, Telegram bilgisi ve yedek kesinlikle yuklenmez.
- `latest.json` aktif surumu bildirir ve su anda v3.1.43'u gosterir.
- EveryCafe veritabani salt okunur kullanilir; EveryCafe'ye yazma yapilmaz.
- Ciro kaynagi: EveryCafe gercek gelir + KafePin dogrudan satis. Cark maliyeti genel cirodan dusulmez; ayri maliyet olarak izlenir.
- Isletme gunu siniri 20:00'dir; 20:00 sonrasi gelir yeni isletme gunune aittir. Devreden masa varsa devir geliri ayrica belirtilir ve ikinci kez ciroya eklenmez.
- Bundan sonraki bir degisiklik gerekiyorsa v3.1.43 degistirilmez; yeni kumulatif surum numarasi ile (v3.1.44+) devam edilir.
