# ISF (Interactive Shader Format) for VS Code

## Setup

Files with `.isf` extension are recognized automatically. For `.fs` and `.vs` files (the standard ISF extensions), you need to manually associate them since they conflict with F# and other languages. Add this to your workspace or user settings:

```json
"files.associations": {
    "*.fs": "isf",
    "*.vs": "isf"
}
```

You can also scope this to specific directories (e.g. `"shaders/*.fs": "isf"`), or select "ISF" from the language picker in the bottom-right corner of the editor.

## Features

### JSON header

- **Autocompletion** for all ISF fields (`INPUTS`, `PASSES`, `IMPORTED`, `CATEGORIES`, `ISFVSN`, etc.)
- **Hover documentation** on all fields and values
- **Validation** with helpful error messages:
  - Unknown fields, wrong value types, mismatched `LABELS`/`VALUES` lengths
  - Non-standard `ISFVSN` values
- **Formatting**
- Syntax highlighting

### GLSL body

Delegates to any installed GLSL extension:

- **Autocompletion** for all ISF built-ins (`RENDERSIZE`, `TIME`, `IMG_THIS_PIXEL`, …) and your own `INPUTS`, `IMPORTED` images and `PASSES` buffers
- **Hover** on built-ins shows their type and description
- **Error diagnostics** from the GLSL language server, remapped to the correct line in your ISF file
- **Formatting** of the GLSL body

### ISF version awareness

The extension reads `ISFVSN` and tailors the preamble accordingly:

| Built-in                          | v1  | v2  |
| --------------------------------- | --- | --- |
| `RENDERSIZE`, `TIME`, `PASSINDEX` | ✓   | ✓   |
| `vv_FragNormCoord`                | ✓   | —   |
| `isf_FragNormCoord`               | —   | ✓   |
| `TIMEDELTA`, `FRAMEINDEX`, `DATE` | —   | ✓   |
| `IMG_SIZE`                        | —   | ✓   |

Using a v2 built-in in a v1 shader (or vice versa) produces a warning with a clear fix suggestion.

### Vertex shaders (`.vs`)

Paired `.vs` files (same name as the `.fs`) get the same INPUTS in scope plus `isf_vertShaderInit()` / `vv_vertShaderInit()`.

## Requirements

For GLSL autocompletion, hover, and error diagnostics, install a GLSL extension. The extension will prompt you if none is detected.

## Extension Settings

No settings.

## Known Issues

- Shadow files (`.isf-shadows/`) are created at the workspace root to enable GLSL analysis. This directory is hidden from the file explorer and has a `.gitignore` created automatically.
