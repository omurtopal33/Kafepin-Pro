# KafePin Pro v4.0.4 STABLE Lock

Date: 2026-08-27
Channel: STABLE / FINAL
Base: v3.1.64
Cumulative: yes
Source test commit: `f249325643283a0312a90f609081650a8bcd04d4`
Windows workflow: `33056796602` — PASS

## Locked behavior

- v4.0.4 is promoted only from the field-tested unified candidate source and its passing Windows workflow artifact.
- Update payload contains seven targeted program files and contains no `database.db`, `database.db-wal`, or `database.db-shm`.
- Fail-safe stale update-lock recovery, active updater protection, bounded timeout and successful-install leftover-lock finalization are locked.
- `runChildTracked` fast-exit/timeout callback completion remains exactly once; PRO refresh cannot wait 150 seconds after a healthy immediate child exit.
- Yazıcı PRO readiness requires HTTP 200 and matching metadata version on ports 17891 and 17893; no hard-coded 3.1.x comparison is used.
- Yazıcı Paneli and e-Devlet / Resmî Belgeler remain in the same KafePin WebView2 experience. Popup/new-window requests remain inside the same view.
- e-Devlet service charge is added once after successful login; physical PrintService output charges accumulate live and remain pending until explicit confirmation.
- Duplicate print events cannot duplicate income. Remove-one and delete actions do not silently confirm finance.
- EveryCafe remains read-only. Missing-close recovery is idempotent and uses bounded SQLite busy retry.
- Durable day-end acknowledgement remains effective across restarts.
- v4.0.2 rollback, DB, finance, session/spin, updater safety and existing PRO behavior remain cumulative unless explicitly listed above.

## Final audit

- Windows Actions run `33056796602`: PASS.
- Fail-safe tests: normal update, interrupted update, dead PID, stale lock, active supervisor, leftover successful lock and failed-update UI recovery: PASS.
- Child-process tests: immediate exit, slow timeout and late close: PASS.
- e-Devlet session pricing test: service 10 + print 10 + print 10, duplicate prevention, remove-one and delete-without-sale: PASS.
- Candidate desktop C# compile: PASS (two pre-existing unawaited-call warnings only).
- Live KafePin/DB health and Yazıcı PRO 17891/17893 health: PASS.
- Live desktop and Yazıcı revenue source matched the tested payload after newline normalization.
- STABLE ZIP SHA-256: `b19eba57237cf3d023740733ed01f166d4e8a881dae3b15ee3d8462a77f0614e`.

Any future behavior change must ship as a new TEST version before replacing this STABLE lock.
