# Technical Design

## Execution Model

- `setup` clones `AppHandle` and schedules `restore_persisted_file_access` through `tauri::async_runtime::spawn_blocking`, then immediately returns `Ok(())`.
- `migrate_legacy_file_access` becomes an async Tauri command. It moves owned arguments into `spawn_blocking` and calls a private blocking implementation.
- Both restoration and migration acquire `FsAccessState.legacy_migration` before reading or mutating persisted grant state. Whichever starts first completes atomically before the other observes state.

## Frontend Ordering

- `App` continues to render independently of initialization state.
- Database path queries use `Promise.all`.
- Session tab reads continue only after the async migration promise resolves, preserving authorization-before-read.

## Error Contract

- Background setup restoration logs failures without crashing startup.
- IPC join failure maps to `file access migration task failed: ...`.
- Existing migration result fields and authorization errors remain unchanged.
