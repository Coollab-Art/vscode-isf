import * as vscode from 'vscode'

export interface JsonRegion {
    // Extracted JSON content. On single-line headers the opening delimiter is replaced with
    // spaces to preserve column positions. Virtual line V -> real line (startLine + V), same col.
    content: string
    // Line in the real file where the /* comment opener appears (may be above startLine)
    commentLine: number
    // Line in the real file where the opening { appears (always >= commentLine)
    startLine: number
    // Line in the real file where the closing } appears (last line of JSON content)
    endLine: number
    // Line in the real file where */ appears (may be below endLine when there is whitespace between } and */)
    commentEndLine: number
}

export interface GlslRegion {
    // GLSL content — everything after the closing */ line
    content: string
    /** Line in the real file where the GLSL body starts */
    startLine: number
}

export interface IsfRegions {
    json: JsonRegion | null
    glsl: GlslRegion | null
}

// Parse an ISF file to find the JSON header and GLSL body regions.
// If no header is found, the whole file is treated as GLSL.
// Handles both `/*{...}*/` (same line) and `/*\n{...}\n*/` (separate lines) formats,
// including whitespace between /* and { or between } and */.
export function parseIsf(text: string): IsfRegions {
    const lines = text.split('\n')
    let commentLine = -1   // line where /* appears
    let jsonStart = -1     // line where { appears (start of virtual JSON content)
    let commentEndLine = -1 // line where */ appears

    for (let i = 0; i < lines.length; i++) {
        if (commentLine === -1 && lines[i].trimStart().startsWith('/*')) {
            commentLine = i
            // { may be on the same line as /*
            if (lines[i].includes('{')) {
                jsonStart = i
            }
        }
        if (commentLine !== -1 && jsonStart === -1 && lines[i].includes('{')) {
            jsonStart = i
        }
        if (commentLine !== -1 && lines[i].includes('*/')) {
            commentEndLine = i
            break
        }
    }

    if (commentLine === -1 || jsonStart === -1 || commentEndLine === -1) {
        return {
            json: null,
            glsl: lines.length > 0 ? { content: text, startLine: 0 } : null,
        }
    }

    // Find the last line containing } at or before commentEndLine — that's the JSON closing brace.
    let jsonEndLine = jsonStart
    for (let i = commentEndLine; i >= jsonStart; i--) {
        if (lines[i].includes('}')) {
            jsonEndLine = i
            break
        }
    }

    // Build virtual JSON content from jsonStart to jsonEndLine.
    // When /* and { are on the same line, replace `/*` with two spaces to preserve column positions.
    const rawLines = lines.slice(jsonStart, jsonEndLine + 1)
    const lastIdx = rawLines.length - 1
    const jsonLines = rawLines.map((line, i) => {
        let result = line
        if (i === 0 && jsonStart === commentLine) {
            // Replace /* with spaces so virtual col == real col on this line
            result = result.replace('/*', '  ')
        }
        if (i === lastIdx) {
            // Truncate at the last } on this line, dropping any trailing */ or whitespace.
            const lastBrace = result.lastIndexOf('}')
            if (lastBrace !== -1) {
                result = result.slice(0, lastBrace + 1)
            }
        }
        return result
    })

    const glslStartLine = commentEndLine + 1
    return {
        json: {
            content: jsonLines.join('\n'),
            commentLine,
            startLine: jsonStart,
            endLine: jsonEndLine,
            commentEndLine,
        },
        glsl:
            glslStartLine < lines.length
                ? { content: lines.slice(glslStartLine).join('\n'), startLine: glslStartLine }
                : null,
    }
}

/**
 * Map a position in the virtual JSON document back to the real ISF file.
 *
 * Because `/*` is replaced with two spaces (when on the same line as `{`), column positions
 * are identical between the virtual and real documents.
 * Real line = startLine + virtualLine, same column.
 */
export function mapJsonToReal(virtualLine: number, virtualCol: number, region: JsonRegion): vscode.Position {
    return new vscode.Position(region.startLine + virtualLine, virtualCol)
}

/**
 * Map a position in the virtual GLSL document back to the real ISF file.
 * Returns null if the position falls within the prepended preamble (no real counterpart).
 */
export function mapGlslToReal(
    virtualLine: number,
    virtualCol: number,
    region: GlslRegion,
    preambleLineCount: number
): vscode.Position | null {
    if (virtualLine < preambleLineCount) return null
    return new vscode.Position(region.startLine + virtualLine - preambleLineCount, virtualCol)
}

/** Map a real ISF file position to its position in the virtual JSON document. */
export function mapRealToJson(realLine: number, realCol: number, region: JsonRegion): vscode.Position | null {
    if (realLine < region.startLine || realLine > region.endLine) return null
    return new vscode.Position(realLine - region.startLine, realCol)
}

/** Map a real ISF file position to its position in the virtual GLSL document. */
export function mapRealToGlsl(
    realLine: number,
    realCol: number,
    region: GlslRegion,
    preambleLineCount: number
): vscode.Position | null {
    if (realLine < region.startLine) return null
    return new vscode.Position(preambleLineCount + realLine - region.startLine, realCol)
}
