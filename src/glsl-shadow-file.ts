// Shadow file manager: for each open ISF file, maintains a real .glsl file on disk
// containing: static preamble + dynamic per-file declarations + GLSL body.
// This gives any GLSL extension full knowledge of all identifiers.
//
// Shadow files live in a `.isf-shadows/` directory at the workspace root so that
// VS Code's file watcher picks up changes and auto-refreshes the in-memory document.
// The directory is hidden from the explorer via `files.exclude` and ignored in git.
// We write to disk with Node fs and open the document once with
// openTextDocument (no visible tab). Subsequent writes are auto-refreshed by the
// file watcher, keeping the document always clean (never dirty).
//
// Pattern inspired by 'hediet-power-tools' markdown code block projections.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { IsfRegions } from './isf-parser'

const SHADOW_DIR_NAME = '.isf-shadows'

// ISF TYPE -> GLSL type mapping
const TYPE_TO_GLSL: Record<string, string> = {
    float:    'float',
    bool:     'bool',
    long:     'int',
    point2D:  'vec2',
    color:    'vec4',
    image:    'sampler2D',
    audio:    'sampler2D',
    audioFFT: 'sampler2D',
    event:    'bool',
}

export class ShadowFileManager {
    private readonly shadowDirPath: string
    private readonly preambleLines: string[]
    private readonly v1OnlyLines: string[]
    private readonly v2SharedLines: string[]
    private readonly v2OnlyLines: string[]
    private readonly fsPreambleLines: string[]
    private readonly v1VsPreambleLines: string[]
    private readonly v2VsPreambleLines: string[]
    // Map from real document URI string -> shadow info
    private readonly shadows = new Map<string, { shadowUri: vscode.Uri, headerLineCount: number, content: string, doc: vscode.TextDocument | undefined }>()
    private readonly disposables: vscode.Disposable[] = []

    constructor(preambleText: string, v1OnlyText: string, v2SharedText: string, v2OnlyText: string, fsPreambleText: string, v1VsPreambleText: string, v2VsPreambleText: string) {
        // Use the first workspace folder as the root for shadow files
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        if (!workspaceRoot) {
            throw new Error('No workspace folder found for ISF shadow files')
        }
        this.shadowDirPath = path.join(workspaceRoot, SHADOW_DIR_NAME)
        fs.mkdirSync(this.shadowDirPath, { recursive: true })

        // Auto-create .gitignore so shadow files are never committed
        const gitignorePath = path.join(this.shadowDirPath, '.gitignore')
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, '*\n', 'utf8')
        }

        this.preambleLines = preambleText.trimEnd().split('\n')
        this.v1OnlyLines = v1OnlyText.trimEnd().split('\n')
        this.v2SharedLines = v2SharedText.trimEnd().split('\n')
        this.v2OnlyLines = v2OnlyText.trimEnd().split('\n')
        this.fsPreambleLines = fsPreambleText.trimEnd().split('\n')
        this.v1VsPreambleLines = v1VsPreambleText.trimEnd().split('\n')
        this.v2VsPreambleLines = v2VsPreambleText.trimEnd().split('\n')

        // When VS Code garbage-collects a shadow document, clear the cached
        // reference. It will be re-opened lazily on the next update() or
        // openShadowDocument() call, avoiding focus-stealing reopens.
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                for (const [, shadow] of this.shadows) {
                    if (shadow.doc === doc) {
                        shadow.doc = undefined
                    }
                }
            })
        )
    }

    // Update (or create) the shadow file for a given ISF document.
    // Writes to disk via Node fs. Since the file is in the workspace,
    // VS Code's file watcher auto-refreshes the in-memory document, triggering
    // GLSL re-analysis with a single signal.
    // siblingRegions: for vertex shaders (no JSON header), the parsed regions of a sibling with a JSON header.
    async update(realDoc: vscode.TextDocument, regions: IsfRegions, siblingRegions?: IsfRegions): Promise<void> {
        const key = realDoc.uri.toString()
        const shadowUri = this.makeShadowUri(realDoc.uri)
        const isVertexShader = !regions.json

        // For vertex shaders, use sibling regions for version + declarations; fall back to own regions.
        const headerRegions = siblingRegions ?? regions
        const isV2 = parseIsfVersion(headerRegions) === IsfVersion.V2
        const declarations = generateDeclarations(headerRegions)
        const headerParts: string[] = [...this.preambleLines]
        if (isV2) {
            headerParts.push(...this.v2SharedLines)
            headerParts.push(...this.v2OnlyLines)
        } else {
            headerParts.push(...this.v1OnlyLines)
        }
        if (isVertexShader) {
            headerParts.push(...(isV2 ? this.v2VsPreambleLines : this.v1VsPreambleLines))
        } else {
            headerParts.push(...this.fsPreambleLines)
        }
        headerParts.push('')
        if (declarations.length > 0) {
            headerParts.push('// -- Per-file ISF declarations --')
            headerParts.push(...declarations)
            headerParts.push('')
        }
        const headerLineCount = headerParts.length
        const glslBody = regions.glsl?.content ?? ''
        const content = [...headerParts, glslBody].join('\n')

        const existing = this.shadows.get(key)

        // Skip disk write if content hasn't changed — avoids triggering
        // a full GLSL re-analysis cycle on the shadow file for no reason.
        if (existing?.content === content) return

        this.shadows.set(key, { shadowUri, headerLineCount, content, doc: existing?.doc })

        // Write with Node fs to avoid VS Code's workspace file-system events,
        // which can refresh the explorer and steal focus.
        fs.writeFileSync(shadowUri.fsPath, content, 'utf8')

        // Ensure the shadow document is open in the model so the GLSL extension watches it.
        // openTextDocument does NOT open a visible tab.
        if (!existing?.doc) {
            const shadow = this.shadows.get(key)!
            shadow.doc = await vscode.workspace.openTextDocument(shadowUri)
        }
    }

    getShadowUri(realUri: vscode.Uri): vscode.Uri | undefined {
        return this.shadows.get(realUri.toString())?.shadowUri
    }

    getHeaderLineCount(realUri: vscode.Uri): number {
        return this.shadows.get(realUri.toString())?.headerLineCount ?? 0
    }

    // Reverse lookup: given a shadow URI, find the real ISF file URI
    getRealUri(shadowUri: vscode.Uri): vscode.Uri | undefined {
        const shadowPath = shadowUri.fsPath
        for (const [realUriStr, info] of this.shadows) {
            if (info.shadowUri.fsPath === shadowPath) {
                return vscode.Uri.parse(realUriStr)
            }
        }
        return undefined
    }

    // Open the shadow document (for forwarding completions/hover).
    // Returns the cached doc if available, otherwise opens from disk.
    async openShadowDocument(realUri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
        const shadow = this.shadows.get(realUri.toString())
        if (!shadow) return undefined
        if (!shadow.doc) {
            shadow.doc = await vscode.workspace.openTextDocument(shadow.shadowUri)
        }
        return shadow.doc
    }

    // Get the latest shadow content string (always fresh, no stale cache).
    getContent(realUri: vscode.Uri): string | undefined {
        return this.shadows.get(realUri.toString())?.content
    }

    // Open a fresh temp document with the latest shadow content.
    // Uses a unique filename each time so openTextDocument always reads from disk.
    // The caller should call cleanupTempFile() when done.
    async openFreshShadowDocument(realUri: vscode.Uri): Promise<{ document: vscode.TextDocument, tempPath: string } | undefined> {
        const shadow = this.shadows.get(realUri.toString())
        if (!shadow) return undefined
        const tempPath = path.join(this.shadowDirPath, `_fmt_${randomUUID()}.glsl`)
        fs.writeFileSync(tempPath, shadow.content, 'utf8')
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(tempPath))
        return { document, tempPath }
    }

    cleanupTempFile(tempPath: string): void {
        try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
    }

    remove(realUriStr: string): void {
        const shadow = this.shadows.get(realUriStr)
        if (shadow) {
            vscode.workspace.fs.delete(shadow.shadowUri).then(() => {}, err => console.warn('ISF: failed to delete shadow file:', err))
            this.shadows.delete(realUriStr)
        }
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose()
        for (const [, info] of this.shadows) {
            vscode.workspace.fs.delete(info.shadowUri).then(() => {}, err => console.warn('ISF: failed to delete shadow file:', err))
        }
        this.shadows.clear()
    }

    private makeShadowUri(realUri: vscode.Uri): vscode.Uri {
        const name = path.basename(realUri.fsPath, path.extname(realUri.fsPath))
        const hash = simpleHash(realUri.toString())
        return vscode.Uri.file(path.join(this.shadowDirPath, `${name}_${hash}.glsl`))
    }

    // Add .isf-shadows/ to files.exclude so it doesn't show in the explorer
    async hideFromExplorer(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('files')
            const exclude: Record<string, boolean> = { ...config.get('exclude') }
            const key = SHADOW_DIR_NAME + '/'
            if (!exclude[key]) {
                exclude[key] = true
                await config.update('exclude', exclude, vscode.ConfigurationTarget.Workspace)
            }
        } catch (err) {
            console.warn('ISF: failed to hide shadow directory from explorer:', err)
        }
    }
}

function simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
    }
    return Math.abs(hash).toString(36)
}

export enum IsfVersion { V1 = 'v1', V2 = 'v2' }

// Parse the ISF version from the JSON header.
// Missing ISFVSN defaults to v1, matching the ISF spec and our compiler (see isf.rs).
// Version numbers >= 2.0 are treated as v2, everything else (invalid strings, v1.x) as v1.
export function parseIsfVersion(regions: IsfRegions): IsfVersion {
    if (!regions.json) return IsfVersion.V1
    let header: Record<string, unknown>
    try {
        header = JSON.parse(regions.json.content)
    } catch {
        return IsfVersion.V1
    }
    const version = header.ISFVSN
    if (version === undefined || version === null) return IsfVersion.V1
    const num = Number(version)
    if (isNaN(num) || num < 2) return IsfVersion.V1
    return IsfVersion.V2
}

// Generate GLSL uniform/sampler declarations from the ISF JSON header.
function generateDeclarations(regions: IsfRegions): string[] {
    if (!regions.json) return []

    let header: Record<string, unknown>
    try {
        header = JSON.parse(regions.json.content)
    } catch {
        return []
    }

    const lines: string[] = []

    // INPUTS -> uniform declarations
    const inputs = header.INPUTS
    if (Array.isArray(inputs)) {
        for (const input of inputs) {
            if (!input || typeof input !== 'object') continue
            const name = (input as Record<string, unknown>).NAME
            const type = (input as Record<string, unknown>).TYPE
            if (typeof name !== 'string' || typeof type !== 'string') continue
            const glslType = TYPE_TO_GLSL[type]
            if (!glslType) continue
            const label = (input as Record<string, unknown>).LABEL
            if (typeof label === 'string') {
                lines.push(`/// ${label}`)
            }
            lines.push(`uniform ${glslType} ${name};`)
        }
    }

    // IMPORTED -> sampler2D declarations
    const imported = header.IMPORTED
    if (imported && typeof imported === 'object' && !Array.isArray(imported)) {
        for (const name of Object.keys(imported)) {
            lines.push(`uniform sampler2D ${name};`)
        }
    }

    // PASSES -> sampler2D declarations for named targets
    const passes = header.PASSES
    if (Array.isArray(passes)) {
        for (const pass of passes) {
            if (!pass || typeof pass !== 'object') continue
            const target = (pass as Record<string, unknown>).TARGET
            if (typeof target !== 'string') continue
            lines.push(`uniform sampler2D ${target};`)
        }
    }

    return lines
}
