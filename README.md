# ISF (Interactive Shader Format) for VS Code

Full IDE support for [ISF](https://isf.video/) shaders: autocompletion, hover documentation, error diagnostics, and formatting — powered by any installed GLSL extension.

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

For GLSL autocompletion, hover, and error diagnostics, install a GLSL extension.

## Extension Settings

No settings required.

## Known Issues

- Shadow files (`.isf-shadows/`) are created at the workspace root to enable GLSL analysis. This directory is hidden from the file explorer and should be added to `.gitignore`.
