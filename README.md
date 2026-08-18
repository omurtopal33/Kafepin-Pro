# KafePin Pro Update Center

Bu depo KafePin Pro guncelleme paketleri icindir.

## KILITLI / STABLE DURUM

- **v3.1.29 = STABLE FULL BASE.** Yeni kafe kurulumu ve tum kumulatif guncellemelerin guvenli tabanidir.
- **v3.1.38 = KILITLI GUNCEL STABLE.** EveryCafe tam gelir senkronu, gunluk kaynak ciro kontrolu, urun/OrderID kontrolu, bilet/diger gelir senkronu ve Iptal / Ucretsiz / Silinenler audit sistemi dahil son onayli surumdur.
- v3.1.38 kumulatiftir; v3.1.29 uzerine dogrudan kurulabilir. Ara surumleri kurmak gerekmez.
- Depoda dagitim paketi olarak yalniz v3.1.29 tabani ve v3.1.38 guncel paket tutulur.

## Guncelleme guvenligi

- Kafe veritabani, token, IP, Telegram bilgisi ve yedek kesinlikle yuklenmez.
- `latest.json` aktif surumu bildirir ve su anda v3.1.38'i gosterir.
- EveryCafe veritabani salt okunur kullanilir; EveryCafe'ye yazma yapilmaz.
- Gider entegrasyonu yapilmaz.
- Bundan sonraki bir degisiklik gerekiyorsa v3.1.38 degistirilmez; yeni bir kumulatif surum numarasi ile devam edilir.
