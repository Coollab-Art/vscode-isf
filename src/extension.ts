import * as vscode from 'vscode'
import * as fs from 'fs'
import { parseIsf, IsfRegions } from './isf-parser'
import { IsfCompletionProvider, IsfHoverProvider } from './language-features'
import { IsfFormattingProvider } from './formatter'
import { IsfJsonFeatures } from './json-features'
import { ShadowFileManager, parseIsfVersion, IsfVersion } from './glsl-shadow-file'

// Preamble files inlined at build time by esbuild's text loader
import preamble from '../glsl/isf-preamble.glsl'
import v1Only from '../glsl/isf-fs-v1-preamble.glsl'
import v2Shared from '../glsl/isf-v2-preamble.glsl'
import v2Only from '../glsl/isf-fs-v2-preamble.glsl'
import fsPreamble from '../glsl/isf-fs-preamble.glsl'
import v1VsPreamble from '../glsl/isf-vs-v1-preamble.glsl'
import v2VsPreamble from '../glsl/isf-vs-v2-preamble.glsl'

// JSON schema inlined at build time
import schema from '../schemas/isf-header.schema.json'

const LANGUAGE_ID = 'isf'

export function activate(context: vscode.ExtensionContext): void {
    const jsonFeatures = new IsfJsonFeatures(schema as any)

    // Shadow file manager: maintains a real .glsl file per ISF document
    // so that any GLSL extension can provide full completions, hover, and diagnostics.
    // Requires a workspace folder for the shadow directory; without one, GLSL features are disabled.
    let shadowManager: ShadowFileManager | undefined
    if (vscode.workspace.workspaceFolders?.length) {
        shadowManager = new ShadowFileManager(preamble, v1Only, v2Shared, v2Only, fsPreamble, v1VsPreamble, v2VsPreamble)
        context.subscriptions.push({ dispose: () => shadowManager!.dispose() })
    } else {
        vscode.window.showWarningMessage('ISF: Open a folder for full GLSL support (diagnostics, completions, formatting). JSON header features work without a folder.')
    }

    // Warn once if no GLSL extension is installed
    const hasGlslExtension = vscode.extensions.all.some(ext => {
        const langs = ext.packageJSON?.contributes?.languages
        return Array.isArray(langs) && langs.some((l: { id?: string }) => l.id === 'glsl')
    })
    if (!hasGlslExtension && !context.globalState.get('isf.glslWarningDismissed')) {
        vscode.window.showInformationMessage(
            'Install a GLSL extension for full ISF support (diagnostics, completions, formatting).',
            'Search Extensions',
            'Don\'t Show Again',
        ).then(choice => {
            if (choice === 'Search Extensions') {
                vscode.commands.executeCommand('workbench.extensions.search', 'glsl')
            } else if (choice === 'Don\'t Show Again') {
                context.globalState.update('isf.glslWarningDismissed', true)
            }
        })
    }

    const regionCache = new Map<string, IsfRegions>()
    const jsonDiagnostics = vscode.languages.createDiagnosticCollection('isf-json')
    const glslDiagnostics = vscode.languages.createDiagnosticCollection('isf-glsl')
    const versionDiagnostics = vscode.languages.createDiagnosticCollection('isf-version')

    // Debounce timers per document to avoid re-parsing mid-edit states
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
    // Track which documents are currently being formatted to skip re-parsing during format application
    const formattingInFlight = new Set<string>()

    async function handleDocument(doc: vscode.TextDocument): Promise<void> {
        if (doc.languageId !== LANGUAGE_ID) return
        const regions = parseIsf(doc.getText())
        regionCache.set(doc.uri.toString(), regions)

        // For .vs files, find and parse the sibling .fs to get JSON header (INPUTS, ISFVSN, etc.)
        let siblingRegions: IsfRegions | undefined
        if (doc.uri.fsPath.endsWith('.vs')) {
            const siblingPath = doc.uri.fsPath.slice(0, -3) + '.fs'
            const siblingUri = vscode.Uri.file(siblingPath)
            const siblingDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === siblingUri.toString())
            if (siblingDoc) {
                siblingRegions = parseIsf(siblingDoc.getText())
            } else {
                try {
                    siblingRegions = parseIsf(fs.readFileSync(siblingPath, 'utf8'))
                } catch { /* no sibling .fs */ }
            }
        }

        // Update the shadow file with preamble + per-file declarations + GLSL body.
        // Uses vscode.workspace.fs.writeFile which notifies the document model,
        // and ensures the shadow doc is open so the GLSL extension watches it.
        await shadowManager?.update(doc, regions, siblingRegions)

        if (regions.json) {
            jsonFeatures.getDiagnostics(regions.json).then(diags => {
                jsonDiagnostics.set(doc.uri, diags)
            }, err => console.warn('ISF: JSON diagnostics failed:', err))
        } else {
            jsonDiagnostics.set(doc.uri, [])
        }

        const isVertexShader = doc.uri.fsPath.endsWith('.vs')
        // For .vs files: use the .fs sibling's JSON (for version detection) but the .vs GLSL body (for scanning).
        const regionsForVersionCheck: IsfRegions = siblingRegions
            ? { json: siblingRegions.json, glsl: regions.glsl }
            : regions
        versionDiagnostics.set(doc.uri, checkVersionMismatch(regionsForVersionCheck, isVertexShader))
    }

    function scheduleHandleDocument(doc: vscode.TextDocument): void {
        const key = doc.uri.toString()
        const existing = debounceTimers.get(key)
        if (existing) clearTimeout(existing)
        debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key)
            if (formattingInFlight.has(key)) return
            handleDocument(doc)
        }, 50))
    }

    context.subscriptions.push(
        jsonDiagnostics,
        glslDiagnostics,
        versionDiagnostics,
        vscode.languages.registerCompletionItemProvider(
            LANGUAGE_ID,
            new IsfCompletionProvider(jsonFeatures, regionCache, shadowManager),
            '"', ':'
        ),
        vscode.languages.registerHoverProvider(
            LANGUAGE_ID,
            new IsfHoverProvider(jsonFeatures, regionCache, shadowManager),
        ),
        vscode.languages.registerDocumentFormattingEditProvider(
            LANGUAGE_ID,
            new IsfFormattingProvider(regionCache, formattingInFlight, shadowManager),
        ),
        vscode.workspace.onDidOpenTextDocument(doc => handleDocument(doc)),
        vscode.workspace.onDidChangeTextDocument(e => scheduleHandleDocument(e.document)),
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc.languageId !== LANGUAGE_ID) return
            const key = doc.uri.toString()
            const timer = debounceTimers.get(key)
            if (timer) { clearTimeout(timer); debounceTimers.delete(key) }
            regionCache.delete(key)
            shadowManager?.remove(key)
            jsonDiagnostics.delete(doc.uri)
            glslDiagnostics.delete(doc.uri)
            versionDiagnostics.delete(doc.uri)
        }),
        // Forward GLSL diagnostics from shadow files to real ISF files
        vscode.languages.onDidChangeDiagnostics(e => {
            if (!shadowManager) return
            for (const uri of e.uris) {
                const realUri = shadowManager.getRealUri(uri)
                if (!realUri) continue

                const regions = regionCache.get(realUri.toString())
                if (!regions?.glsl) continue

                const headerLineCount = shadowManager.getHeaderLineCount(realUri)
                const shadowDiags = vscode.languages.getDiagnostics(uri)

                const remapped = shadowDiags
                    .filter(d => d.range.start.line >= headerLineCount)
                    .map(d => {
                        const startLine = d.range.start.line - headerLineCount + regions.glsl!.startLine
                        const endLine = d.range.end.line - headerLineCount + regions.glsl!.startLine
                        return new vscode.Diagnostic(
                            new vscode.Range(
                                new vscode.Position(startLine, d.range.start.character),
                                new vscode.Position(endLine, d.range.end.character),
                            ),
                            d.message,
                            d.severity,
                        )
                    })

                glslDiagnostics.set(realUri, remapped)
            }
        }),
    )

    // Process documents already open when the extension activates
    for (const doc of vscode.workspace.textDocuments) {
        handleDocument(doc)
    }
}

export function deactivate(): void {}

// Identifiers that only exist in one ISF version, with guidance toward the correct alternative.
const V2_ONLY: { pattern: string, v1Alternative?: string, vertexOnly?: boolean }[] = [
    { pattern: 'TIMEDELTA' },
    { pattern: 'FRAMEINDEX' },
    { pattern: 'DATE' },
    { pattern: 'IMG_SIZE' },
    { pattern: 'isf_FragNormCoord',    v1Alternative: 'vv_FragNormCoord' },
    { pattern: 'isf_vertShaderInit',   v1Alternative: 'vv_vertShaderInit', vertexOnly: true },
]
const V1_ONLY: { pattern: string, v2Alternative?: string, vertexOnly?: boolean }[] = [
    { pattern: 'vv_FragNormCoord',   v2Alternative: 'isf_FragNormCoord' },
    { pattern: 'vv_vertShaderInit',  v2Alternative: 'isf_vertShaderInit', vertexOnly: true },
]

// Scan the GLSL body for version-mismatched identifiers and return warning diagnostics.
function checkVersionMismatch(regions: IsfRegions, isVertexShader: boolean): vscode.Diagnostic[] {
    if (!regions.glsl) return []

    const v2OnlyFiltered = V2_ONLY.filter(i => !i.vertexOnly || isVertexShader)
    const v1OnlyFiltered = V1_ONLY.filter(i => !i.vertexOnly || isVertexShader)
    const v2Pattern = new RegExp(`\\b(${v2OnlyFiltered.map(i => i.pattern).join('|')})\\b`, 'g')
    const v1Pattern = new RegExp(`\\b(${v1OnlyFiltered.map(i => i.pattern).join('|')})\\b`, 'g')

    const version = parseIsfVersion(regions)
    const diagnostics: vscode.Diagnostic[] = []
    const lines = regions.glsl.content.split('\n')

    for (let i = 0; i < lines.length; i++) {
        const realLine = regions.glsl.startLine + i

        if (version === IsfVersion.V1) {
            for (const match of lines[i].matchAll(v2Pattern)) {
                const info = v2OnlyFiltered.find(id => id.pattern === match[1])!
                let message = `'${match[1]}' is only available in ISF v2. Add "ISFVSN": "2.0" to your JSON header to use it.`
                if (info.v1Alternative) {
                    message += ` Or use '${info.v1Alternative}' if you want to stay in v1.`
                }
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(realLine, match.index!, realLine, match.index! + match[1].length),
                    message,
                    vscode.DiagnosticSeverity.Warning,
                ))
            }
        } else {
            for (const match of lines[i].matchAll(v1Pattern)) {
                const info = v1OnlyFiltered.find(id => id.pattern === match[1])!
                let message = `'${match[1]}' is an ISF v1 identifier.`
                if (info.v2Alternative) {
                    message += ` Use '${info.v2Alternative}' instead.`
                }
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(realLine, match.index!, realLine, match.index! + match[1].length),
                    message,
                    vscode.DiagnosticSeverity.Warning,
                ))
            }
        }
    }
    return diagnostics
}
