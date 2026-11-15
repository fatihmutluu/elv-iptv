# Main-Process Catalog Coordinator (`src/main/catalog/`)

Main-process wiring for the desktop SQLite catalog `utilityProcess` and OS-encrypted `SecretStore`.

- `worker-protocol.ts`: runtime-validated `main <-> utilityProcess` `parentPort` message shapes (`init`, `ready`, `client-port`, `client-disconnect`, `secret-request`, `secret-reply`, `shutdown`, `shutdown-complete`).
- `secret-store.ts`: `SecretStore` backed by Electron's async `safeStorage` API (`userData/secrets.json`, `0o600`, serialized atomic write + rename). Fails closed when OS encryption is unavailable or Linux falls back to `basic_text`.
- `coordinator.ts`: lazily spawns `dist/utility/catalog-worker.js`, bridges `SecretStore` exclusively over `parentPort`, transfers per-client `MessageChannelMain` ports, and coordinates bounded shutdown or crash recovery.
- `ipc.ts`: registers `catalog:connect`, transfers `MessagePortMain` to the owning `webContents`, and fences ports on navigation, reload, crash, or window close.
- `dev-seed.ts`: unpackaged development-only (`__ELV_DEV_SEED__ && !app.isPackaged`) first-launch seeder (`elv.dev.seeded` in `SecretStore`, `#10`); tree-shaken out of production `dist/main/main.js`.
