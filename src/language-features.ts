import * as vscode from 'vscode'
import { IsfRegions } from './isf-parser'
import { IsfJsonFeatures } from './json-features'
import { ShadowFileManager } from './glsl-shadow-file'

export class IsfCompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private readonly jsonFeatures: IsfJsonFeatures,
        private readonly regionCache: Map<string, IsfRegions>,
        private readonly shadowManager: ShadowFileManager | undefined,
    ) {}

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | null> {
        const regions = this.regionCache.get(document.uri.toString())
        if (!regions) return null

        // JSON header region -- provide schema-based completions
        if (regions.json && position.line >= regions.json.startLine && position.line <= regions.json.endLine) {
            return this.jsonFeatures.getCompletions(regions.json, position.line, position.character)
        }

        // GLSL body region -- forward to shadow file for full completions
        if (this.shadowManager && regions.glsl && position.line >= regions.glsl.startLine) {
            const shadowDoc = await this.shadowManager.openShadowDocument(document.uri)
            if (shadowDoc) {
                const headerLineCount = this.shadowManager.getHeaderLineCount(document.uri)
                const virtualLine = headerLineCount + (position.line - regions.glsl.startLine)
                const virtualPos = new vscode.Position(virtualLine, position.character)

                const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
                    'vscode.executeCompletionItemProvider',
                    shadowDoc.uri,
                    virtualPos,
                )

                if (completions?.items.length) {
                    for (const item of completions.items) {
                        remapCompletionRange(item, headerLineCount, regions.glsl.startLine)
                    }
                    return completions.items
                }
            }
        }

        return null
    }
}

export class IsfHoverProvider implements vscode.HoverProvider {
    constructor(
        private readonly jsonFeatures: IsfJsonFeatures,
        private readonly regionCache: Map<string, IsfRegions>,
        private readonly shadowManager: ShadowFileManager | undefined,
    ) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Hover | null> {
        const regions = this.regionCache.get(document.uri.toString())
        if (!regions) return null

        // JSON header region -- provide schema-based hover
        if (regions.json && position.line >= regions.json.startLine && position.line <= regions.json.endLine) {
            return this.jsonFeatures.getHover(regions.json, position.line, position.character)
        }

        // GLSL body region -- forward to shadow file
        if (this.shadowManager && regions.glsl && position.line >= regions.glsl.startLine) {
            const shadowDoc = await this.shadowManager.openShadowDocument(document.uri)
            if (shadowDoc) {
                const headerLineCount = this.shadowManager.getHeaderLineCount(document.uri)
                const virtualLine = headerLineCount + (position.line - regions.glsl.startLine)
                const virtualPos = new vscode.Position(virtualLine, position.character)

                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    'vscode.executeHoverProvider',
                    shadowDoc.uri,
                    virtualPos,
                )

                if (hovers?.length) {
                    const hover = hovers[0]
                    if (hover.range) {
                        hover.range = remapRange(hover.range, headerLineCount, regions.glsl.startLine)
                    }
                    return hover
                }
            }
        }

        return null
    }
}

// Remap a range from shadow GLSL coordinates to real ISF file coordinates
function remapRange(range: vscode.Range, headerLineCount: number, glslStartLine: number): vscode.Range {
    return new vscode.Range(
        new vscode.Position(range.start.line - headerLineCount + glslStartLine, range.start.character),
        new vscode.Position(range.end.line - headerLineCount + glslStartLine, range.end.character),
    )
}

// Remap completion item ranges from shadow to real coordinates
function remapCompletionRange(item: vscode.CompletionItem, headerLineCount: number, glslStartLine: number): void {
    if (item.range) {
        if (item.range instanceof vscode.Range) {
            item.range = remapRange(item.range, headerLineCount, glslStartLine)
        } else if ('inserting' in item.range) {
            item.range = {
                inserting: remapRange(item.range.inserting, headerLineCount, glslStartLine),
                replacing: remapRange(item.range.replacing, headerLineCount, glslStartLine),
            }
        }
    }
}
