# KafePin Pro v4.0.2 — KÜMÜLATİF STABLE

v4.0.2, kullanıcı tarafından sahada hızlı ve stabil olduğu onaylanan FIX5 paketinin STABLE yayınıdır. Yeni runtime değişikliği, refactor veya özellik eklenmemiştir.

## Güncelleme güvenliği

- Hızlı hedefli program rollback uygulanır.
- Update paketinde DB dosyaları yasaktır; update sırasında `database.db`, `database.db-wal` ve `database.db-shm` dosyalarına dokunulmaz.
- Gerçek disk I/O stall durumları için 90 saniye watchdog bulunur.
- Çift update/backup yarışı engellenir.

## Client Performans ve EveryCafe

- Client Performans bağlantı hızı göstergesi Ping yanında gösterilir.
- 1000 Mbps altı bağlantılarda uyarı gösterilir.
- Client Performans yerel servisi 17896 portunda tek-instance korumasına sahiptir.
- EveryCafe `SQLITE_BUSY` durumları bounded retry ile ele alınır; EveryCafe salt-okunur kalır.
- Manager → Recovery akışında KafePin sunucu ve DB sağlık doğrulaması zorunludur.

Yeni kafe kurulum tabanı politika gereği `v3.1.64` olarak kalır.
