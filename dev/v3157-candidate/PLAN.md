# v3.1.57 candidate

Field fix for v3.1.56 updater failure: `Yazici PRO SHA256 dogrulamasi basarisiz: yazici-pro-version.json`.

Design: package ZIP SHA remains the trust boundary. Manager verifies each copied Yazici payload file by comparing the actual source file SHA256 in the already-verified package to the destination SHA256 after copy. No build-time embedded payload SHA is used as the runtime truth, eliminating stale hash drift.

STABLE remains v3.1.49.
