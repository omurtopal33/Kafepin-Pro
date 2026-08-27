# v4.0.5 TEST - Browser-only 50/10 limiter

Pilot hedefi: tum masalarda yalnız Chrome/Edge web trafiğini 50 Mbps indirme / 10 Mbps yükleme ile sınırlamak. Oyun, EveryCafe, KafePin, NXD ve LAN trafiği proxy yoluna alınmaz. Agent/proxy erişilemezse PAC `DIRECT` fallback içerir (fail-open).

- Control: TCP 17906, `X-KafePin-Token` ile paylaşılan anahtar.
- Local browser proxy: 127.0.0.1:17907.
- PAC: `http://127.0.0.1:17906/proxy.pac`.
- Yalnız Chrome/Edge policy kullanılır; global WinINET/WinHTTP proxy değiştirilmez.
- Private IPv4/LAN/localhost PAC tarafından `DIRECT` bırakılır.
- Diskless/Super WKS kurulumu tamamlandığında ilk politika `AKTIF 50/10` olarak yazılır ve install akışı agent health ile kontrol endpoint'ini doğrular.
- Sonraki Aç/Kapat işlemleri Client Performans PRO üzerinden yapılır; agent state dosyasına kaydedilir ve restart sonrası son durum korunur.
- Client Performans PRO kartları agent canlı health olmadan `AKTİF` göstermez.
- Tek masa ve toplu Aç/Kapat desteklenir.
- EveryCafe DB erişimine hiçbir değişiklik yoktur.

TEST kanalı açılmadan önce: restart, Chrome/Edge indirme, Speedtest, oyun ping, EveryCafe/KafePin/NXD, LAN, agent kill fail-open, uninstall/rollback doğrulanmalıdır.
