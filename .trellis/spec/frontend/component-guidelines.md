# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

<!-- How styles are applied (CSS modules, styled-components, Tailwind, etc.) -->

(To be filled by the team)

---

## Accessibility

<!-- A11y requirements and patterns -->

(To be filled by the team)

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)

## Scenario: Large Markdown Preview Pipeline

### 1. Scope / Trigger

- Trigger: `MarkdownPreview` content is at least 50,000 UTF-16 code units.
- Owner: `src/services/markdownPreviewParser*.ts` owns parsing; `MarkdownPreview.tsx` owns viewport mounting.

### 2. Signatures

- Request: `{ id: number, content: string }`.
- Success: `{ id: number, result: { blocks: MarkdownPreviewBlock[] } }`.
- Failure: `{ id: number, error: string }`.
- Block: `{ key: string, startLine: number, endLine: number, tree: HastRoot }`.

### 3. Contracts

- The worker runs the same GFM, math, KaTeX, highlight, raw-HTML escaping, and URL filtering behavior as the small-document `ReactMarkdown` path.
- `key` ignores AST positions, while `startLine/endLine` always use current source positions.
- Placeholder wrappers retain `data-md-line/data-md-end-line`; mounted blocks retain their renderer after leaving the viewport.

### 4. Validation & Error Matrix

- Worker missing or constructor blocked -> reject the Promise -> synchronous `ReactMarkdown` fallback.
- Parse/plugin failure -> worker error response -> synchronous fallback.
- Older request finishes late -> the component compares the captured content and ignores the result.
- `IntersectionObserver` missing -> mount the block immediately.

### 5. Good/Base/Bad Cases

- Good: a large document parses off-main-thread and mounts only eager/nearby blocks.
- Base: a small document renders synchronously without Worker startup latency.
- Bad: parsing the whole large document inside render, or removing line attributes from placeholders.

### 6. Tests Required

- `npm run test:markdown-preview`: stable keys, line shifts, GFM, code, math, Mermaid, footnotes, raw HTML, unsafe URLs, and no-Worker rejection.
- `scripts/markdown-preview-browser-check.js`: initial placeholders exist and a far TOC target mounts on demand.
- `npm run test:markdown-math` and `npm run build` must remain green.

### 7. Wrong vs Correct

#### Wrong

```tsx
<ReactMarkdown>{hugeDocument}</ReactMarkdown>
```

#### Correct

```tsx
const result = await parseMarkdownPreviewInWorker(hugeDocument)
return result.blocks.map(renderVirtualBlock)
```
