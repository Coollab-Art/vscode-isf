# ISF VSCode Extension

*2026 March 11*

## Context

ISF shaders (`.fs`/`.vs`) embed a JSON metadata block inside a `/*{...}*/` comment, followed by GLSL code. Without a dedicated extension, VS Code provides no autocomplete or schema validation for the JSON header, and ISF builtins like `RENDERSIZE` and `TIME` are unknown to GLSL extensions.

---

## Architecture Evolution

The extension went through four architectures:

### Arch 1: Virtual documents with custom URI schemes (rejected)

Registered a custom `isf` language ID. Created virtual documents (`isf-json://`, `isf-glsl://`) via `TextDocumentContentProvider` to route embedded language regions to JSON and GLSL language servers.

**Why rejected:** VS Code's built-in JSON LS only handles `file://` and `untitled://` schemes - custom-scheme documents got nothing. Some GLSL extensions similarly ignored custom schemes.

> User: "it does not work. We already tried the TextDocumentContentProvider approach and realized that some glsl extensions do not support it right?"

### Arch 2: Register as `glsl` language, no shadow files (rejected)

Since `/*{...}*/` is a valid GLSL comment, the whole file was treated as GLSL natively. Extension registered for `glsl` language and only provided JSON features + static ISF builtin completions/hover.

**Pros:** Very simple. No shadow files, no range remapping.

**Why rejected:** No JSON syntax highlighting in the header. GLSL extensions still report "undeclared identifier" for per-file INPUT/IMPORTED/PASSES variables (the static preamble only covers ISF builtins, not user-declared inputs).

> User: "the preamble should also include the declaration of all the INPUT and IMPORTED variables, so it should be dynamic and per-file"

### Arch 3: Shadow files in extension storage (rejected)

Registered a custom `isf` language with TextMate grammar (embedded JSON + GLSL highlighting). Created real `.glsl` shadow files in `globalStorageUri/shadows/` containing: static preamble + per-file declarations + GLSL body. Used `applyEdit()` to keep the in-memory document in sync.

**Why rejected:** Fragile sync between disk and in-memory model:
- `applyEdit()` made the document dirty -> "unsaved" prompts on close
- Adding `save()` after `applyEdit()` caused "content is newer" race with `writeFileSync`
- Even after fixing the race (skip `writeFileSync` when doc is open), `save()` sent a second signal to the GLSL extension -> diagnostic flickering and errors on wrong lines
- `globalStorageUri` is outside the workspace -> VS Code's file watcher doesn't cover it, so disk-only writes didn't trigger GLSL re-analysis

### Arch 4: Shadow files in workspace (current)

Inspired by hediet-power-tools' markdown code block projections. Shadow files live in `.isf-shadows/` at the workspace root. Written to disk via `vscode.workspace.fs.writeFile`. The document is opened once with `openTextDocument` (no visible tab). Subsequent disk writes are auto-refreshed by VS Code's file watcher because the files are inside the workspace.

**Key insight:** VS Code's file watcher monitors files inside the workspace. When an open, clean document's underlying file changes on disk, VS Code silently refreshes the in-memory model - triggering a single `didChange` signal to the GLSL extension. No `applyEdit`, no `save()`, no dirty state.

**Pros:**
- Single signal to GLSL extension per edit -> no flickering
- Document is always clean -> no "unsaved" prompts
- Works with any GLSL extension (delegates all analysis)

**Cons:**
- Creates a hidden directory in the workspace (mitigated by `files.exclude` + `.gitignore`)

---

## Key Decisions

### `vscode-json-languageservice` for JSON features

The built-in VS Code JSON LS refuses custom URI schemes. We embed `vscode-json-languageservice` (the same underlying library) directly.

**Alternative considered:** write JSON to a real temp `.json` file - same shadow-file problems.

---

### Custom `isf` language with TextMate grammar

The extension registers `isf` as a custom language (not `glsl`), with a TextMate grammar that provides embedded JSON highlighting in the `/*{...}*/` header and GLSL highlighting for the body. This gives JSON syntax coloring that Arch 2 lacked.

---

### Shadow file location: workspace root

Shadow files go in `.isf-shadows/` at the workspace root, hidden from the explorer via `files.exclude` (set programmatically by the extension) and ignored by git via `.gitignore`. This is the only location where VS Code's file watcher reliably picks up changes to auto-refresh open documents.

**Alternative considered:** `globalStorageUri` (extension-private storage) - file watcher doesn't cover it, so disk writes don't trigger GLSL re-analysis.

---

### Write to disk only, no `applyEdit`

All shadow file updates go through `vscode.workspace.fs.writeFile` (VS Code's async file API). The document is opened once with `openTextDocument` and never modified via `applyEdit`. VS Code's file watcher keeps the model in sync.

**Alternatives tried:**
- `applyEdit` only (no save): works but document stays dirty -> "unsaved" prompts
- `applyEdit` + `save()`: double signal -> flickering diagnostics, errors on wrong lines
- `fs.writeFileSync` (Node's direct I/O): bypasses VS Code's file layer, model not updated

---

### Re-open shadow documents on close

If VS Code closes a shadow document (garbage collection), the extension re-opens it via `onDidCloseTextDocument`. This keeps the GLSL extension active on the shadow file.

---

### Column-preserving JSON extraction

When `/*` and `{` are on the same line, `/*` is replaced with two spaces (same width). Virtual column C always maps to real column C - no column offset needed.

---

### ISF builtins from preamble file

`glsl/isf-preamble.glsl` declares all ISF builtins with `/** */` doc comments. Parsed at activation to provide completions and hover as a fallback when the GLSL extension returns nothing.

> User: "we should not rely on the behaviour of one specific glsl extension, we want to work with all of them"

---

### Format-on-save race

Formatter writes can race with the file-watcher refresh. We debounce `onDidChangeTextDocument` (50ms) and skip while a `formattingInFlight` flag is active (500ms). GLSL formatting uses a unique temp file each time so `openTextDocument` always reads fresh content. Format edits are filtered to body-only to prevent the generated preamble from leaking into the GLSL body.
