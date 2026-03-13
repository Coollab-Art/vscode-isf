import * as vscode from 'vscode'
import { parseIsf, IsfRegions, JsonRegion } from './isf-parser'
import { ShadowFileManager } from './glsl-shadow-file'

export class IsfFormattingProvider implements vscode.DocumentFormattingEditProvider {
    constructor(
        private readonly regionCache: Map<string, IsfRegions>,
        private readonly formattingInFlight: Set<string>,
        private readonly shadowManager: ShadowFileManager | undefined,
    ) {}

    async provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
    ): Promise<vscode.TextEdit[]> {
        const key = document.uri.toString()

        // Skip if another format is still being applied (prevents rapid-fire corruption)
        if (this.formattingInFlight.has(key)) return []

        // Parse fresh from the current document text to avoid stale cache issues
        const regions = parseIsf(document.getText())
        if (!regions.json && !regions.glsl) return []

        // Update the cache and shadow file so they reflect the latest content
        // (the debounced handleDocument may not have run yet if the user saved quickly)
        this.regionCache.set(key, regions)
        await this.shadowManager?.update(document, regions)

        // Mark this document as formatting-in-flight so handleDocument skips re-parsing
        // while VS Code applies our edits. Cleared when the edit is applied (onDidChangeTextDocument)
        // or after a safety timeout.
        this.formattingInFlight.add(key)
        const clearFormatting = () => this.formattingInFlight.delete(key)
        const safetyTimeout = setTimeout(clearFormatting, 5000)
        const listener = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() === key) {
                clearTimeout(safetyTimeout)
                listener.dispose()
                clearFormatting()
            }
        })

        const edits: vscode.TextEdit[] = []

        if (regions.json) {
            const jsonEdit = this.formatJsonRegion(document, regions.json, options)
            if (jsonEdit) edits.push(jsonEdit)
        }

        const glslEdit = await this.formatGlslRegion(document, regions, options)
        if (glslEdit) edits.push(glslEdit)

        // If no edits, VS Code won't fire onDidChangeTextDocument, so clean up now
        if (edits.length === 0) {
            clearTimeout(safetyTimeout)
            listener.dispose()
            clearFormatting()
        }

        return edits
    }

    // Format the /*{...}*/ JSON header using JSON.parse + JSON.stringify.
    private formatJsonRegion(
        document: vscode.TextDocument,
        region: JsonRegion,
        options: vscode.FormattingOptions,
    ): vscode.TextEdit | undefined {
        let parsed: unknown
        try {
            parsed = JSON.parse(region.content)
        } catch {
            return undefined // Don't format if JSON is invalid
        }

        const indent = options.insertSpaces ? options.tabSize : '\t'
        const body = collapseShortNumericArrays(JSON.stringify(parsed, null, indent))

        // Replace from the /* comment opener through any blank lines after */,
        // then add exactly one blank line so the GLSL body is separated from the header.
        let rangeEndLine = region.commentEndLine
        const lineCount = document.lineCount
        while (rangeEndLine + 1 < lineCount && document.lineAt(rangeEndLine + 1).isEmptyOrWhitespace) {
            rangeEndLine++
        }
        const realRange = new vscode.Range(
            new vscode.Position(region.commentLine, 0),
            document.lineAt(rangeEndLine).rangeIncludingLineBreak.end
        )
        return vscode.TextEdit.replace(realRange, '/*' + body + '*/\n\n')
    }

    // Format the GLSL body: write current shadow content to a fresh temp file,
    // let the GLSL extension format it, apply edits in memory, copy GLSL body back.
    // Uses a unique temp file each time so openTextDocument always gets fresh content.
    private async formatGlslRegion(
        document: vscode.TextDocument,
        regions: IsfRegions,
        options: vscode.FormattingOptions,
    ): Promise<vscode.TextEdit | undefined> {
        if (!regions.glsl || !this.shadowManager) return undefined

        const content = this.shadowManager.getContent(document.uri)
        if (!content) return undefined

        const result = await this.shadowManager.openFreshShadowDocument(document.uri)
        if (!result) return undefined

        const headerLineCount = this.shadowManager.getHeaderLineCount(document.uri)

        let shadowEdits: vscode.TextEdit[] | undefined
        try {
            shadowEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                'vscode.executeFormatDocumentProvider',
                result.document.uri,
                options,
            )
        } finally {
            this.shadowManager.cleanupTempFile(result.tempPath)
        }

        if (!shadowEdits?.length) return undefined

        // Only keep edits that fall entirely within the GLSL body (after the preamble).
        // Otherwise the formatter reshuffles the preamble, changing its line count,
        // and our headerLineCount-based slicing extracts the wrong lines.
        const bodyEdits = shadowEdits.filter(e => e.range.start.line >= headerLineCount)
        if (!bodyEdits.length) return undefined

        // Apply the format edits to the known-fresh content
        const formattedShadow = applyTextEdits(content, bodyEdits)

        // Extract just the GLSL body (everything after the preamble + declarations header)
        const formattedLines = formattedShadow.split('\n')
        const formattedGlsl = formattedLines.slice(headerLineCount).join('\n')

        // Replace the entire GLSL region in the ISF file
        const lastLine = document.lineCount - 1
        const glslRange = new vscode.Range(
            new vscode.Position(regions.glsl.startLine, 0),
            new vscode.Position(lastLine, document.lineAt(lastLine).text.length),
        )

        // Only emit an edit if the content actually changed
        const currentGlsl = document.getText(glslRange)
        if (currentGlsl === formattedGlsl) return undefined

        return vscode.TextEdit.replace(glslRange, formattedGlsl)
    }
}

// Apply TextEdits to a string in memory, returning the result.
function applyTextEdits(content: string, edits: vscode.TextEdit[]): string {
    // Sort edits bottom-to-top, right-to-left so earlier offsets stay valid
    const sorted = [...edits].sort((a, b) => {
        if (b.range.start.line !== a.range.start.line) return b.range.start.line - a.range.start.line
        return b.range.start.character - a.range.start.character
    })

    const lines = content.split('\n')

    for (const edit of sorted) {
        const startLine = edit.range.start.line
        const startChar = edit.range.start.character
        const endLine = edit.range.end.line
        const endChar = edit.range.end.character

        const before = lines[startLine].substring(0, startChar)
        const after = (lines[endLine] ?? '').substring(endChar)
        const newLines = (before + edit.newText + after).split('\n')

        lines.splice(startLine, endLine - startLine + 1, ...newLines)
    }

    return lines.join('\n')
}

// Collapse 2- and 4-element all-numeric arrays onto a single line after JSON.stringify.
// This keeps point2D ([x, y]) and color ([r, g, b, a]) values readable without vertical sprawl.
function collapseShortNumericArrays(json: string): string {
    const num = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?'
    const sep = '[ \\t]*\\n[ \\t]*' // single newline with surrounding horizontal whitespace
    return json
        .replace(new RegExp(`\\[${sep}(${num}),${sep}(${num})${sep}\\]`, 'g'), '[$1, $2]')
        .replace(new RegExp(`\\[${sep}(${num}),${sep}(${num}),${sep}(${num}),${sep}(${num})${sep}\\]`, 'g'), '[$1, $2, $3, $4]')
}
