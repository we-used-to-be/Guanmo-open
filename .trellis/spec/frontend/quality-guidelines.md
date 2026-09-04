# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

## Scenario: AI Answer and Retrieval Routing

### 1. Scope / Trigger

- Applies when changing answer prompts, source rendering, Agent intent detection, RAG scheduling, or long-term-memory retrieval for rewrite requests.

### 2. Signatures

- `isLocalResearchIntent(query: string): boolean`
- `classifyMemoryRetrievalIntent(query: string): 'none' | 'weak' | 'strong'`
- `searchMemories(query, { categories?: readonly string[] }): Promise<Memory[]>`
- `scheduleMarkdownDocumentIndex(path, title, content, delay?): boolean`

### 3. Contracts

- Plain questions and simple explanations remain concise and do not require source placeholders.
- Explicit topic research may search the full local knowledge base without a tag; a specific-file summary still requires a file tag, and any rewrite still requires a current selection/file tag.
- Personalized rewrites retrieve only active `preference` or `instruction` memories; ordinary rewrites do not retrieve memory.
- Manual saves use the default 1.2-second index delay; auto-save callers pass 5 seconds. Per-file scheduling must keep only the latest pending content.

### 4. Validation & Error Matrix

- No actual local/Web source -> render no `Sources` section.
- Research has no useful result -> answer states the evidence gap; do not invent sources.
- Specific-file summary has no tag -> do not claim exact file coverage.
- Rewrite has no current tag -> refuse before generating an edit confirmation.
- Personalized rewrite finds no style memory -> follow the current request without inventing a preference.

### 5. Good/Base/Bad Cases

- Good: `研究 Node.js 单线程` triggers local research; `帮我按我的风格改写这段` performs light style-memory retrieval.
- Base: `Node.js 单线程是什么` and `帮我改写这段` add no retrieval latency.
- Bad: treating every `归纳` as full-library research, showing an empty source footer, or allowing historical tags to authorize edits.

### 6. Tests Required

- `npm run test:agent-parser`: topic research positive cases plus plain-Q&A and scoped-file negative cases.
- `npm run test:memory`: personalized rewrite positive cases plus ordinary rewrite negative cases.
- `npm run test:rag-index`: exact hashing, incremental reuse, and per-file serialization.
- `npm run build` and `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
const shouldLookupMemory = /改写|润色/.test(query)
```

#### Correct

```ts
const shouldLookupMemory = isPersonalizedRewriteMemoryIntent(query)
const categories = shouldLookupMemory ? ['preference', 'instruction'] : undefined
```

## Scenario: Desktop File Policy Gateway

### 1. Scope / Trigger

- Applies to every desktop file read/write, binary operation, create/remove/rename, existence check, directory listing, file reveal, dialog selection, native drag-drop, file association, and Markdown asset preview.

### 2. Signatures

- `read_text_file_by_path({ path }) -> string`
- `write_text_file_by_path({ path, content }) -> void`
- `read_binary_file_by_path({ path }) -> number[]`
- `write_binary_file_by_path({ path, content: number[] }) -> void`
- `create_text_file_by_path({ path }) -> void`
- `create_dir_by_path({ path }) -> void`
- `path_exists({ path }) -> boolean`
- `remove_file_by_path({ path }) -> void`
- `rename_text_file_by_path({ oldPath, newPath }) -> void`
- `read_dir_by_path({ path }) -> DirectoryEntry[]`
- `reveal_file_in_folder({ path }) -> void`
- `migrate_legacy_file_access({ workspacePaths: string[], filePaths: string[] }) -> { status, workspaceCount, fileCount, ignoredCount, pendingCount }`

### 3. Contracts

- `src/hooks/useTauri.ts` is the only frontend file adapter. It invokes custom Rust commands and never imports or falls back to `@tauri-apps/plugin-fs`.
- `authorize_selected_path` and `authorize_workspace_path` accept only paths already placed in Tauri's runtime fs scope by a user dialog.
- File-association paths are registered by `take_pending_open_files`; native drop paths are registered by Rust `on_webview_event` before frontend use.
- `read_dir_by_path` requires an existing workspace authorization and never creates one.
- Markdown sibling `assets` directories stay in a dedicated image-only policy set and asset protocol scope; they are not workspaces.
- The main-window capability contains no `fs:*` permission, and the initial asset protocol scope contains no global wildcard.
- Rust persists only grants created at trusted native boundaries and restores valid canonical paths before the frontend session is hydrated.
- A version-upgrade compatibility migration may submit the saved workspace, recent files, favorites, restored tabs, RAG document paths, and historical local AI sources exactly once. Rust persists a completion marker; frontend-persisted paths cannot expand grants after that marker. Valid absolute paths that are temporarily unavailable remain in a bounded Rust-owned pending queue and are retried on later launches. Entries absent from the original snapshot require one same-path native selection.
- `status=already_migrated` ignores all new frontend arguments but may report grants restored from the Rust-owned pending queue. `pendingCount` is the number of unavailable validated paths retained for another launch.
- Startup `setup` only schedules persisted-grant restoration through `tauri::async_runtime::spawn_blocking`. The async migration command delegates all `exists`, `canonicalize`, and scope-registration work to the blocking pool; restoration and migration share the migration mutex, while session file reads still await completion.

### 4. Validation & Error Matrix

- Relative path or parent traversal -> reject before authorization lookup.
- Unsupported text/image extension -> reject before filesystem access.
- Path outside all workspaces, selected files, and Markdown assets -> reject every action.
- Frontend requests authorization for a path absent from dialog fs scope -> `file/workspace was not selected by the user`.
- Selected file used as a directory -> reject.
- Markdown assets used for text read or directory listing -> reject.
- Existing target during rename or create-new -> reject without overwriting.
- First migration sees a valid absolute supported path that is unavailable -> retain it in the Rust-owned pending queue without granting it.
- Later retry sees the pending path available with the expected kind -> canonicalize, grant, remove it from pending, and persist; wrong-kind or invalid pending records are removed as ignored.
- Blocking-pool task join failure -> return `file access migration task failed: ...`; startup restoration failure -> log and continue rendering.

### 5. Good/Base/Bad Cases

- Good: user selects a folder, Rust registers it, then descendants can be listed and edited through custom commands.
- Good: an offline drive path from the one-time snapshot remains pending and is restored automatically after the drive reconnects.
- Base: user selects one Markdown file; only that file and image operations in its sibling `assets` directory are available.
- Bad: catch a Rust command error and retry with `plugin-fs`, auto-authorize the first directory read, accept an arbitrary frontend path after migration completion, or discard a trusted grant only because its drive is offline during startup.

### 6. Tests Required

- Rust unit matrix must assert every `FileAction` rejects an unauthorized path and accepts workspace descendants.
- Assert selected-file authorization is exact and does not permit directory actions.
- Assert Markdown assets permit image actions but reject text reads, directory reads, and non-image removal.
- Run `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `cargo check --manifest-path src-tauri/Cargo.toml`, `npm run build`, relevant Markdown/RAG checks, source/config grep audits, and `git diff --check`.
- Run `npm run test:file-access` to cover authorization-only recovery, cancellation, non-authorization failures, and every persisted-path call site.
- Persisted-grant tests must assert old JSON defaults pending fields to empty, pending paths survive serialization with the completion marker, and the retry implementation is present in the startup migration path.
- Static scheduling checks must fail if `setup` calls restoration directly, the migration command stops being async, blocking work escapes `spawn_blocking`, or session restore moves before migration completion.

### 7. Wrong vs Correct

#### Wrong

```ts
try {
  return await invoke('read_text_file_by_path', { path })
} catch {
  return readTextFile(path)
}
```

#### Correct

```ts
return invoke('read_text_file_by_path', { path })
```
