# KafePin Pro v4.0.2 STABLE Lock

Date: 2026-08-26
Channel: STABLE / FINAL
Base: v3.1.64
Cumulative: yes

## Locked behavior

- v4.0.2 is promoted from the field-tested FIX5 package without adding a new runtime feature after the successful test.
- Local ZIP update preflight rejects `database.db`, `database.db-wal`, and `database.db-shm` paths.
- Local updates do not run a slow DB VACUUM/snapshot. Only existing program files that the package will replace are copied to `UPDATE_SAFETY` with SHA-256 metadata for rollback.
- The targeted rollback copy uses a 90-second watchdog only for genuine disk I/O stalls.
- A second click / WebView reopen reconnects to an already-running update instead of starting a competing backup/install flow.
- Client Performans PRO shows physical link speed beside Ping; link speeds below 1000 Mbps are visually warned.
- Client Performans PRO keeps single-instance protection for its local service / port.
- Short EveryCafe SQLite busy windows use bounded retry while EveryCafe remains read-only.
- Windows Server Manager remains the primary restart authority; safe Recovery is the fallback and success requires KafePin server + DB health.
- Existing v4.0.1 and v3.1.92 protected finance, spin/session, monitor, USB/MP3/PRO, Telegram, and 20:00 day-end behavior remains cumulative.

## Final audit

- `node --check`: passed for `server.js`, `services/spinService.js`, `utils/fee.js`, and `KafePin_Update_Supervisor.js`.
- Package manifest: 30 payload files present.
- DB-file prohibition in update manifest: passed.
- `update.json` / `kafepin-pro-version.json`: synchronized as v4.0.2 STABLE / FINAL.
- Desktop metadata promoted from test suffix to `1.2.2`.
- No new optimization/refactor was introduced after the successful field test; stability was prioritized over speculative changes.

Any future behavior change must ship as a new TEST version before replacing this STABLE lock.
