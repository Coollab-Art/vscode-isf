# Architecture

A VSCode extension providing IDE support for ISF (Interactive Shader Format) shader files.

See [POST-MORTEM.md](POST-MORTEM.md) for architecture decisions and design rationale.

## What ISF files look like

ISF files (`.fs` / `.vs`) contain two embedded languages:

```
/*{
  "ISFVSN": "2",
  "INPUTS": [...]
}*/

void main() {
  gl_FragColor = vec4(RENDERSIZE, 0.0, 1.0);
}
```

The `/*{...}*/` block is a JSON metadata header. Everything after is GLSL.

## Extension structure

```
package.json                  Language definition (isf), grammar, activation events
language-configuration.json   Bracket pairs, comment config
syntaxes/
  isf.tmLanguage.json         TextMate grammar - JSON header + GLSL body highlighting
schemas/
  isf-header.schema.json      JSON Schema for the ISF /*{...}*/ header
glsl/
  isf-preamble.glsl           ISF builtin declarations (also used as shadow file preamble)
src/
  extension.ts                Entry point - wires everything together
  isf-parser.ts               Region extraction (JSON + GLSL boundaries)
  glsl-shadow-file.ts         Shadow file manager (one .glsl file per ISF document)
  language-features.ts        Completion + hover (forwards to shadow GLSL file, falls back to builtins)
  formatter.ts                JSON + GLSL formatting (delegates GLSL to installed extension)
  json-features.ts            JSON completions, hover, diagnostics via vscode-json-languageservice
  isf-builtins.ts             Parses preamble.glsl into completion items + hover docs
  glsl-extension-config.ts    Auto-configuration for known GLSL extensions
```

## How it works

### Shadow file approach

For each open ISF file, the extension maintains a real `.glsl` shadow file in `.isf-shadows/` at the workspace root. The shadow file contains:

1. **Static preamble** - all ISF builtin declarations from `glsl/isf-preamble.glsl`
2. **Per-file declarations** - `uniform` declarations generated from the ISF JSON header (INPUTS, IMPORTED, PASSES)
3. **GLSL body** - the actual shader code from the ISF file

The shadow file is written to disk via `vscode.workspace.fs.writeFile`. Since it's inside the workspace, VS Code's file watcher auto-refreshes the in-memory document, triggering the GLSL extension to re-analyze. The document is opened once with `openTextDocument` (no visible tab, no `applyEdit`, no dirty state).

### Completions and hover

`IsfCompletionProvider` and `IsfHoverProvider` (in `language-features.ts`) detect which region the cursor is in:

- **JSON header** -> delegate to `IsfJsonFeatures` (embedded `vscode-json-languageservice`)
- **GLSL body** -> forward to the shadow file via `vscode.commands.executeCommand('vscode.executeCompletionItemProvider', ...)`, remap positions back to the ISF file. Falls back to static builtin completions if the GLSL extension returns nothing.

### Diagnostics

GLSL diagnostics from the shadow file are intercepted via `onDidChangeDiagnostics`, filtered to body-only (lines after the preamble), and remapped to ISF file coordinates.

JSON diagnostics come from `vscode-json-languageservice` (schema validation + custom rules in `json-features.ts`).

### Formatting

`IsfFormattingProvider` handles both regions:

- **JSON** - `JSON.parse` + `JSON.stringify` with short numeric array collapsing (keeps `[x, y]` and `[r, g, b, a]` on one line)
- **GLSL** - writes shadow content to a unique temp file, runs `vscode.executeFormatDocumentProvider`, filters edits to body-only (skips preamble), applies edits in memory, copies formatted body back to the ISF file

### TextMate grammar

`isf.tmLanguage.json` provides syntax highlighting with embedded language scopes:
- `meta.embedded.block.json` for the `/*{...}*/` header (gets JSON coloring)
- `meta.embedded.block.glsl` for the GLSL body

## Workspace integration

`.vscode/settings.json` maps file associations:
```json
"files.associations": { "*.fs": "isf", "*.vs": "isf" }
```

The `.isf-shadows/` directory is:
- Hidden from the file explorer via `files.exclude` (set programmatically by the extension)
- Ignored by git via `.gitignore`

Press **F5** to launch the Extension Development Host for testing.

## Installing the extension

```bash
npx vsce package --allow-missing-repository
code --install-extension vscode-isf-0.1.0.vsix
```
