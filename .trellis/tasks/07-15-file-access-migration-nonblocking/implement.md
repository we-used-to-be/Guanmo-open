# Implementation Plan

## Stage 1 - Regression Contract

- [x] Assert setup restoration uses `spawn_blocking`.
- [x] Assert migration command is async and delegates blocking work through `spawn_blocking`.
- [x] Assert frontend preserves database-init -> migration -> session-restore ordering.

## Stage 2 - Rust Scheduling

- [x] Serialize restore/migrate with the existing migration mutex.
- [x] Move setup restoration off the startup thread.
- [x] Wrap migration blocking work in an async Tauri command.

## Stage 3 - Frontend Wait Reduction

- [x] Load RAG and historical AI source paths concurrently.
- [x] Preserve authorization-before-session-read behavior.

## Stage 4 - Verification

- [x] Run file-access regression, build, Rust check/test, static audit and diff check.
- [x] Review dirty boundary and keep `.playwright-cli/` excluded.
