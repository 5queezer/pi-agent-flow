# Web Tool Compact TUI Renderer

## Investigation Findings

### Current State

The `web` tool (src/web-tool.ts) registers **no** `renderCall`/`renderResult` hooks. This means the TUI displays the full raw tool output verbatim — every metadata line, every URL, and the entire 500-char preview block.

**Fetch output** (src/web-tool.ts:366-382): Generates 5+ lines per fetch:
```
File: /tmp/session/abc123.md
Title: Page Title
Content length: 4200 chars

Preview:
<500 characters of page content...>
```

**Search output** (src/web-tool.ts:160-170): Generates ~12 lines for 4 results:
```
1. Result Title
   https://example.com/page
   Snippet text up to 160 chars...

2. Another Title
   https://example.org/other
   Another snippet...
```

The `flow` and `batch` tools already use `renderCall`/`renderResult` hooks for compact TUI display. The pattern is: collapsed = one-line/compact summary, expanded = full text, LLM always receives complete output.

**Evidence:**
- src/index.ts:290: `pi.registerTool(createWebTool())` — no render hooks
- src/index.ts:380-382: flow tool registers `renderCall` and `renderResult`
- src/batch/render.ts: `renderBatchResult` returns `TruncatedText` for collapsed, `Text` for expanded
- src/render.ts:142+: `renderFlowResult` uses `Container`/`Text` with tree-style display (├─/└─)
- src/snapshot.ts:200+: Already compresses web results to `[web:search] "query" · N results · first: Title` and `[web:fetch] url · "Title" · N chars` for child flow context

## User Alignment

| Question | Answer | Impact |
|----------|--------|--------|
| Display-only renderer vs shrink raw output? | TUI-only compact renderer | Raw tool output unchanged; LLM keeps full 500-char preview + metadata. Only TUI display gets compact treatment. |
| Collapsed view format? | Tree-style matching flow UI | Use ├─/└─ prefixes consistent with flow dashboard panels. Visually unified with existing flow output. |
| Scope — fetch only or both? | Both fetch and search | Add renderers for both op types. Search: ├─ search "query" → N results. Fetch: └─ fetch example.com · "Title" · N chars. |

## Technical Context

- **Stack**: TypeScript, @mariozechner/pi-coding-agent extension API, @mariozechner/pi-tui components (Container, Text, TruncatedText, Markdown, Spacer)
- **Pattern**: `renderCall(args, theme)` returns a `Text` node; `renderResult(result, { expanded }, theme, args)` returns `Text | Container | TruncatedText`
- **Theme**: Flow tool uses `FlowTheme` with `theme.fg("muted", ...)` and `theme.fg("accent", ...)` for coloring. Web tool will need access to a compatible theme — either reuse `FlowTheme` from render.ts or define a minimal theme interface.
- **Details object**: The web tool already returns a `details` object with `{ ops: [{ o, q/u, ... }, ...] }` that the renderer can consume for structured display without parsing raw text.
- **Args shape**: `args.op` is `Array<{ o: "search" | "fetch", q?: string, u?: string, f?: string }>`

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|----------|
| Renderer approach | Add `renderCall` + `renderResult` to web tool registration in index.ts | Follows established pattern from flow/batch tools. LLM context untouched. |
| Collapsed format | Tree-style (├─/└─) matching flow dashboard | User preference. Visual consistency with existing flow output. |
| Expanded format | Full raw text (current behavior) | Standard pattern — expanded view shows everything. |
| renderCall format | Compact op list | Show ops being invoked, e.g. `web search "query", fetch example.com` |
| renderResult collapsed - search | `├─ search "query" → N results` (or `└─` for last op) | Tree prefix + query + result count. |
| renderResult collapsed - fetch | `└─ fetch example.com · "Title" · 4200 chars` | Tree prefix + domain + title + char count. No preview. |
| Multiple ops | Each op gets a tree line, last gets └─ | Mirrors flow dashboard multi-flow display. |
| Theme reuse | Import `FlowTheme` type and render utilities from render.ts / render-utils.ts | Avoid duplicating theme logic. Flow theme is already the established visual language. |
| Color scheme | `muted` for tree prefix + labels, `accent` for values (URLs, titles, counts) | Consistent with flow dashboard coloring. |

## Implementation Plan

### Phase 1: Create web renderer module
- Create `src/web-render.ts` (matching flat module structure)
- Implement `renderWebCall(args, theme)` — compact display of ops being invoked
- Implement `renderWebResult(result, expanded, theme, args)` — collapsed tree view + expanded full text
- Use `Text` and `TruncatedText` from `@mariozechner/pi-tui`
- Reuse `FlowTheme` and color utilities (`theme.fg("muted", ...)`, `theme.fg("accent", ...)`)
- Import helper functions from `render-utils.ts` as needed (e.g., `truncateChars`)

### Phase 2: Wire render hooks into web tool registration
- In `src/index.ts`, update `pi.registerTool(createWebTool())` to include `renderCall` and `renderResult`
- Alternative: have `createWebTool()` accept renderers as parameters, or export them separately
- Verify the tool still works end-to-end (raw output unchanged, TUI gets compact display)

### Phase 3: Test
- Add unit tests for `renderWebCall` and `renderWebResult` covering:
  - Single search op
  - Single fetch op
  - Multiple ops (search + fetch)
  - Collapsed vs expanded mode
  - Edge cases: empty results, error responses, missing title/URL
- Follow existing test patterns

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Theme type mismatch between web and flow modules | Import `FlowTheme` directly from render.ts; if not exported, extract a shared theme interface |
| Web tool factory doesn't expose render hooks easily | May need to refactor `createWebTool()` return type or register render hooks separately in index.ts |
| Expanded view regression | Expanded view simply returns the raw text as `Text` — same as current behavior. Low risk. |
| `details` shape changes break renderer | Renderer parses `details.ops` defensively with optional chaining; falls back to raw text on parse failure |

## Assumptions

- The `FlowTheme` type and its `fg()` method are accessible from outside `render.ts` (exported or importable)
- The web tool's `details` object (`{ ops: [...] }`) is stable and available in the `renderResult` callback
- `TruncatedText` from `@mariozechner/pi-tui` handles line truncation for collapsed view correctly
- The `args` passed to `renderCall` match the `webSchema` shape (array of ops under `op` key)
