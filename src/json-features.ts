// Provides completions, hover, and diagnostics for the ISF JSON header region
// using vscode-json-languageservice directly, bypassing VS Code's built-in JSON LS.
//
// The built-in JSON LS only handles `file://` and `untitled://` schemes, so it cannot
// process our virtual documents — hence we embed the same underlying library ourselves.
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import {
    getLanguageService,
    TextDocument as JSONTextDocument,
    JSONSchema,
    InsertTextFormat,
    ASTNode,
    ObjectASTNode,
    ArrayASTNode,
    PropertyASTNode,
    StringASTNode,
} from 'vscode-json-languageservice'
import { JsonRegion } from './isf-parser'

const SCHEMA_URI = 'isf://schema/isf-header.schema.json'
const VIRTUAL_DOC_URI = 'isf://virtual/header.isf.json'

// Properties allowed per input TYPE. When TYPE is already set, we filter out
// completions for property names that don't apply to the chosen type.
const INPUT_PROPS_BY_TYPE: Record<string, Set<string>> = {
    float:    new Set(['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'IDENTITY', 'MIN', 'MAX']),
    bool:     new Set(['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'IDENTITY']),
    long:     new Set(['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'IDENTITY', 'VALUES', 'LABELS']),
    point2D:  new Set(['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'IDENTITY', 'MIN', 'MAX']),
    color:    new Set(['NAME', 'TYPE', 'LABEL', 'DEFAULT', 'IDENTITY']),
    image:    new Set(['NAME', 'TYPE', 'LABEL']),
    event:    new Set(['NAME', 'TYPE', 'LABEL']),
    audio:    new Set(['NAME', 'TYPE', 'LABEL', 'MAX']),
    audioFFT: new Set(['NAME', 'TYPE', 'LABEL', 'MAX']),
}

// Cursor-positioned snippets for top-level array properties (value only, after the colon).
const FIELD_VALUE_SNIPPETS: Record<string, string> = {
    ISFVSN: '"${1:2.0}"',
    PASSES: '[{$0}]',
    INPUTS: '[{$0}]',
    TYPE: '"$0"',
}

// TYPE-specific value snippets for DEFAULT, IDENTITY, MIN, MAX.
// Used to replace the generic schema default with a type-appropriate placeholder.
const TYPE_VALUE_SNIPPETS: Record<string, Record<string, string>> = {
    float:    { DEFAULT: '${1:0.0}',                                 IDENTITY: '${1:0.0}',                                 MIN: '${1:0.0}',             MAX: '${1:1.0}' },
    bool:     { DEFAULT: '${1:false}',                               IDENTITY: '${1:false}' },
    long:     { DEFAULT: '${1:0}',                                   IDENTITY: '${1:0}',                                   LABELS: '["${1:}"]',  VALUES: '[0$0]' },
    point2D:  { DEFAULT: '[${1:0.0}, ${2:0.0}]',                     IDENTITY: '[${1:0.0}, ${2:0.0}]',                     MIN: '[${1:0.0}, ${2:0.0}]', MAX: '[${1:1.0}, ${2:1.0}]' },
    color:    { DEFAULT: '[${1:0.0}, ${2:0.0}, ${3:0.0}, ${4:1.0}]', IDENTITY: '[${1:0.0}, ${2:0.0}, ${3:0.0}, ${4:1.0}]' },
    audio:    { MAX: '${1:1024}' },
    audioFFT: { MAX: '${1:1024}' },
}

// Expected value types per TYPE for DEFAULT/IDENTITY/MIN/MAX validation
type ExpectedKind = 'number' | 'boolean' | 'integer' | 'point2D' | 'color'
const VALUE_TYPE_BY_INPUT_TYPE: Record<string, ExpectedKind> = {
    float:    'number',
    bool:     'boolean',
    long:     'integer',
    point2D:  'point2D',
    color:    'color',
    audio:    'integer',
    audioFFT: 'integer',
}

export class IsfJsonFeatures {
    private readonly service = getLanguageService({
        schemaRequestService: (uri) => {
            if (uri === SCHEMA_URI) return Promise.resolve(this.schemaContent)
            return Promise.reject(`Schema not found: ${uri}`)
        },
    })
    private readonly schemaContent: string

    constructor(schema: JSONSchema) {
        this.schemaContent = JSON.stringify(schema)
        this.service.configure({
            validate: true,
            schemas: [{ uri: SCHEMA_URI, fileMatch: ['*.isf.json'], schema }],
        })
    }

    async getCompletions(
        region: JsonRegion,
        realLine: number,
        realCol: number,
        documentUri?: vscode.Uri,
    ): Promise<vscode.CompletionItem[]> {
        const doc = makeDoc(region)
        const parsed = this.service.parseJSONDocument(doc)
        const virtualPos = { line: realLine - region.startLine, character: realCol }

        // If inside an IMPORTED PATH value, provide file path completions instead
        const offset = doc.offsetAt(virtualPos)
        if (documentUri && isInsideImportedPath(parsed.getNodeFromOffset(offset))) {
            return getFilePathCompletions(documentUri, doc, offset)
        }

        const result = await this.service.doComplete(doc, virtualPos, parsed)
        if (!result) return []

        // Detect the input TYPE at the cursor to filter inapplicable property completions
        const inputType = getInputTypeAtOffset(parsed.getNodeFromOffset(offset))

        return result.items
            .filter(item => {
                if (!inputType) return true
                const allowed = INPUT_PROPS_BY_TYPE[inputType]
                if (!allowed) return true
                return allowed.has(item.label)
            })
            .map(item => {
                const vscodeItem = new vscode.CompletionItem(
                    item.label,
                    item.kind as unknown as vscode.CompletionItemKind,
                )
                vscodeItem.detail = item.detail
                // Sort TYPE first and NAME second inside input objects
                vscodeItem.sortText = item.label === 'TYPE' ? '!0'
                    : item.label === 'NAME' ? '!1'
                    : item.sortText
                vscodeItem.filterText = item.filterText

                if (item.documentation) {
                    vscodeItem.documentation = typeof item.documentation === 'string'
                        ? item.documentation
                        : new vscode.MarkdownString(item.documentation.value)
                }

                // Remap the text edit range from virtual to real positions, handling snippets
                if (item.textEdit && 'range' in item.textEdit) {
                    const r = item.textEdit.range
                    vscodeItem.range = new vscode.Range(
                        new vscode.Position(region.startLine + r.start.line, r.start.character),
                        new vscode.Position(region.startLine + r.end.line, r.end.character),
                    )
                    vscodeItem.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                        ? new vscode.SnippetString(item.textEdit.newText)
                        : item.textEdit.newText
                } else if (typeof item.insertText === 'string') {
                    vscodeItem.insertText = item.insertTextFormat === InsertTextFormat.Snippet
                        ? new vscode.SnippetString(item.insertText)
                        : item.insertText
                }

                // Override MAX description for audio types
                if ((inputType === 'audio' || inputType === 'audioFFT') && item.label === 'MAX') {
                    vscodeItem.documentation = new vscode.MarkdownString(
                        'Number of samples (i.e. the width of the image).\n\n' +
                        'This key is optional — if `MAX` is not defined then the shader will receive audio data ' +
                        'with the number of samples that were provided natively. For example, if the `MAX` of an ' +
                        '"audio"-type input is defined as 1, the resulting 1-pixel-wide image is going to accurately ' +
                        'convey the "total volume" of the audio wave; if you want a 4-column FFT graph, specify a ' +
                        '`MAX` of 4 on an "audioFFT"-type input, etc.'
                    )
                }

                // Detect trailing comma from the language service (present when siblings follow)
                const trailingComma = item.textEdit && 'range' in item.textEdit
                    && item.textEdit.newText.trimEnd().endsWith(',')
                    ? ','
                    : ''

                // Override value placeholder with TYPE-specific snippet when TYPE is known
                if (inputType && vscodeItem.range) {
                    const valueSnippet = TYPE_VALUE_SNIPPETS[inputType]?.[item.label]
                    if (valueSnippet) {
                        vscodeItem.insertText = new vscode.SnippetString(`"${item.label}": ${valueSnippet}${trailingComma}`)
                    }
                }

                // Override array fields with cursor-positioned snippets
                if (!inputType && vscodeItem.range) {
                    const fieldSnippet = FIELD_VALUE_SNIPPETS[item.label]
                    if (fieldSnippet) {
                        vscodeItem.insertText = new vscode.SnippetString(`"${item.label}": ${fieldSnippet}${trailingComma}`)
                    }
                }

                return vscodeItem
            })
    }

    async getHover(
        region: JsonRegion,
        realLine: number,
        realCol: number,
    ): Promise<vscode.Hover | null> {
        const doc = makeDoc(region)
        const parsed = this.service.parseJSONDocument(doc)
        const virtualPos = { line: realLine - region.startLine, character: realCol }

        // Override hover for MAX on audio/audioFFT inputs
        const offset = doc.offsetAt(virtualPos)
        const inputType = getInputTypeAtOffset(parsed.getNodeFromOffset(offset))
        if ((inputType === 'audio' || inputType === 'audioFFT') && isHoveringKey(parsed.getNodeFromOffset(offset), 'MAX')) {
            return new vscode.Hover(new vscode.MarkdownString(
                'Number of samples (i.e. the width of the image).\n\n' +
                'This key is optional — if `MAX` is not defined then the shader will receive audio data ' +
                'with the number of samples that were provided natively. For example, if the `MAX` of an ' +
                '"audio"-type input is defined as 1, the resulting 1-pixel-wide image is going to accurately ' +
                'convey the "total volume" of the audio wave; if you want a 4-column FFT graph, specify a ' +
                '`MAX` of 4 on an "audioFFT"-type input, etc.'
            ))
        }

        const result = await this.service.doHover(doc, virtualPos, parsed)
        if (!result) return null

        const contents: vscode.MarkdownString[] = []
        const raw = result.contents
        if (Array.isArray(raw)) {
            for (const c of raw) {
                contents.push(new vscode.MarkdownString(typeof c === 'string' ? c : c.value))
            }
        } else {
            contents.push(new vscode.MarkdownString(typeof raw === 'string' ? raw : raw.value))
        }

        const range = result.range
            ? new vscode.Range(
                new vscode.Position(region.startLine + result.range.start.line, result.range.start.character),
                new vscode.Position(region.startLine + result.range.end.line, result.range.end.character),
            )
            : undefined
        return new vscode.Hover(contents, range)
    }

    getColorInformations(region: JsonRegion): vscode.ColorInformation[] {
        const doc = makeDoc(region)
        const parsed = this.service.parseJSONDocument(doc)
        if (!parsed.root || parsed.root.type !== 'object') return []

        const inputsProps = (parsed.root as ObjectASTNode).properties.filter(
            p => (p.keyNode as StringASTNode).value === 'INPUTS'
        )

        const results: vscode.ColorInformation[] = []
        for (const inputsProp of inputsProps) {
            if (!inputsProp?.valueNode || inputsProp.valueNode.type !== 'array') continue
            for (const inputNode of (inputsProp.valueNode as ArrayASTNode).items) {
                if (inputNode.type !== 'object') continue
                const inputObj = inputNode as ObjectASTNode

                const typeProp = inputObj.properties.find(p => (p.keyNode as StringASTNode).value === 'TYPE')
                if (!typeProp?.valueNode || typeProp.valueNode.type !== 'string') continue
                if ((typeProp.valueNode as StringASTNode).value !== 'color') continue

                for (const prop of inputObj.properties) {
                    const propName = (prop.keyNode as StringASTNode).value
                    if (propName !== 'DEFAULT' && propName !== 'IDENTITY') continue
                    if (!prop.valueNode || prop.valueNode.type !== 'array') continue

                    const items = (prop.valueNode as ArrayASTNode).items
                    if (items.length !== 4 || items.some(i => i.type !== 'number')) continue

                    const [r, g, b, a] = items.map(i => (i as { value: number }).value)
                    const start = doc.positionAt(prop.valueNode.offset)
                    const end = doc.positionAt(prop.valueNode.offset + prop.valueNode.length)
                    const range = new vscode.Range(
                        new vscode.Position(region.startLine + start.line, start.character),
                        new vscode.Position(region.startLine + end.line, end.character),
                    )
                    results.push(new vscode.ColorInformation(range, new vscode.Color(r, g, b, a)))
                }
            }
        }
        return results
    }

    getColorPresentations(color: vscode.Color): vscode.ColorPresentation[] {
        const fmt = (n: number) => {
            const s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0')
            return s
        }
        const label = `[${fmt(color.red)}, ${fmt(color.green)}, ${fmt(color.blue)}, ${fmt(color.alpha)}]`
        return [new vscode.ColorPresentation(label)]
    }

    async getDiagnostics(region: JsonRegion): Promise<vscode.Diagnostic[]> {
        const doc = makeDoc(region)
        const parsed = this.service.parseJSONDocument(doc)
        const lsDiagnostics = await this.service.doValidation(doc, parsed)
        // Filter out the generic "Duplicate object key" warnings from the LS —
        // we replace them with our own actionable message below.
        const mapped = lsDiagnostics
            .filter(err => !err.message.startsWith('Duplicate object key'))
            .map(err => {
                const range = new vscode.Range(
                    new vscode.Position(region.startLine + err.range.start.line, err.range.start.character),
                    new vscode.Position(region.startLine + err.range.end.line, err.range.end.character),
                )
                const severity = err.severity === 1
                    ? vscode.DiagnosticSeverity.Error
                    : vscode.DiagnosticSeverity.Warning
                return new vscode.Diagnostic(range, err.message, severity)
            })
        return [
            ...mapped,
            ...validateInputs(region, doc, parsed.root),
            ...validateIsfVsn(region, doc, parsed.root),
            ...validateDuplicateKeys(region, doc, parsed.root),
        ]
    }
}

function makeDoc(region: JsonRegion): JSONTextDocument {
    return JSONTextDocument.create(VIRTUAL_DOC_URI, 'json', 1, region.content)
}

// Walk the AST upward from the given node to find the TYPE value of the nearest
// enclosing input object. Returns undefined if no TYPE is found or not a string.
function getInputTypeAtOffset(node: ASTNode | undefined): string | undefined {
    let current: ASTNode | undefined = node
    while (current) {
        if (current.type === 'object') {
            const obj = current as ObjectASTNode
            const typeProp = obj.properties.find(
                (p: PropertyASTNode) => (p.keyNode as StringASTNode).value === 'TYPE'
            )
            if (typeProp?.valueNode?.type === 'string') {
                return (typeProp.valueNode as StringASTNode).value
            }
        }
        current = current.parent
    }
    return undefined
}

// Custom per-input validation: incompatible properties and wrong value types.
function validateInputs(region: JsonRegion, doc: JSONTextDocument, root: ASTNode | undefined): vscode.Diagnostic[] {
    if (!root || root.type !== 'object') return []

    const inputsProps = (root as ObjectASTNode).properties.filter(
        p => (p.keyNode as StringASTNode).value === 'INPUTS'
    )
    if (inputsProps.length === 0) return []

    const diags: vscode.Diagnostic[] = []
    for (const inputsProp of inputsProps) {
        if (!inputsProp?.valueNode || inputsProp.valueNode.type !== 'array') continue
        for (const inputNode of (inputsProp.valueNode as ArrayASTNode).items) {
            if (inputNode.type !== 'object') continue
            const inputObj = inputNode as ObjectASTNode

            const typeProp = inputObj.properties.find(p => (p.keyNode as StringASTNode).value === 'TYPE')
            if (!typeProp?.valueNode || typeProp.valueNode.type !== 'string') continue
            const inputType = (typeProp.valueNode as StringASTNode).value

            const allowed = INPUT_PROPS_BY_TYPE[inputType]
            if (!allowed) continue

            for (const prop of inputObj.properties) {
                const propName = (prop.keyNode as StringASTNode).value

                // Warn about properties that don't apply to this TYPE
                if (!allowed.has(propName)) {
                    diags.push(makeDiag(doc, region, prop.keyNode,
                        `"${propName}" is not applicable for TYPE "${inputType}"`,
                        vscode.DiagnosticSeverity.Warning,
                    ))
                    continue
                }

                // Warn about wrong value types for DEFAULT, IDENTITY, MIN, MAX
                if (!prop.valueNode) continue
                const valueError = checkValueType(inputType, propName, prop.valueNode)
                if (valueError) {
                    diags.push(makeDiag(doc, region, prop.valueNode, valueError, vscode.DiagnosticSeverity.Warning))
                }
            }

            // Warn when LABELS and VALUES have different lengths
            const labelsProp = inputObj.properties.find(p => (p.keyNode as StringASTNode).value === 'LABELS')
            const valuesProp = inputObj.properties.find(p => (p.keyNode as StringASTNode).value === 'VALUES')
            if (labelsProp?.valueNode?.type === 'array' && valuesProp?.valueNode?.type === 'array') {
                const labelsLen = (labelsProp.valueNode as ArrayASTNode).items.length
                const valuesLen = (valuesProp.valueNode as ArrayASTNode).items.length
                if (labelsLen !== valuesLen) {
                    diags.push(makeDiag(doc, region, labelsProp.keyNode,
                        `LABELS has ${labelsLen} item(s) but VALUES has ${valuesLen} — they must have the same length`,
                        vscode.DiagnosticSeverity.Warning,
                    ))
                }
            }
        }
    }
    return diags
}

// Warn if ISFVSN is set to a non-standard value (not "1.0" / "1" family or "2.0" / "2" family).
function validateIsfVsn(region: JsonRegion, doc: JSONTextDocument, root: ASTNode | undefined): vscode.Diagnostic[] {
    if (!root || root.type !== 'object') return []
    const prop = (root as ObjectASTNode).properties.find(p => (p.keyNode as StringASTNode).value === 'ISFVSN')
    if (!prop?.valueNode) return []
    const raw = prop.valueNode.type === 'string'
        ? (prop.valueNode as StringASTNode).value
        : String((prop.valueNode as { value: unknown }).value)
    const num = Number(raw)
    if (!isNaN(num) && (num === 1 || num === 2)) return []
    return [makeDiag(doc, region, prop.valueNode,
        `Non-standard ISF version "${raw}". Only "1.0" and "2.0" exist.`,
        vscode.DiagnosticSeverity.Warning,
    )]
}

// Warn when the same top-level key appears more than once.
function validateDuplicateKeys(region: JsonRegion, doc: JSONTextDocument, root: ASTNode | undefined): vscode.Diagnostic[] {
    if (!root || root.type !== 'object') return []
    const diags: vscode.Diagnostic[] = []
    const seen = new Map<string, PropertyASTNode>()
    for (const prop of (root as ObjectASTNode).properties) {
        const key = (prop.keyNode as StringASTNode).value
        const first = seen.get(key)
        if (first) {
            // Warn on the second (and subsequent) occurrence
            diags.push(makeDiag(doc, region, prop.keyNode,
                `Duplicate key "${key}" — format the file to merge.`,
                vscode.DiagnosticSeverity.Warning,
            ))
            // Also warn on the first occurrence (once)
            if (first.keyNode) {
                diags.push(makeDiag(doc, region, first.keyNode,
                    `Duplicate key "${key}" — format the file to merge.`,
                    vscode.DiagnosticSeverity.Warning,
                ))
                seen.set(key, undefined as any) // prevent re-warning on the first
            }
        } else {
            seen.set(key, prop)
        }
    }
    return diags
}

function checkValueType(inputType: string, propName: string, valueNode: ASTNode): string | undefined {
    const kind = VALUE_TYPE_BY_INPUT_TYPE[inputType]
    if (!kind) return undefined
    const valueProps = new Set(['DEFAULT', 'IDENTITY', 'MIN', 'MAX'])
    if (!valueProps.has(propName)) return undefined

    switch (kind) {
        case 'number':
            if (valueNode.type !== 'number')
                return `Expected a number for "${propName}" (TYPE="${inputType}")`
            break
        case 'boolean':
            if (valueNode.type !== 'boolean')
                return `Expected a boolean for "${propName}" (TYPE="${inputType}")`
            break
        case 'integer':
            if (valueNode.type !== 'number')
                return `Expected an integer for "${propName}" (TYPE="${inputType}")`
            break
        case 'point2D': {
            if (valueNode.type !== 'array')
                return `Expected an array [x, y] for "${propName}" (TYPE="${inputType}")`
            const items = (valueNode as ArrayASTNode).items
            if (items.length !== 2)
                return `Expected exactly 2 elements for "${propName}" (TYPE="${inputType}")`
            if (items.some(i => i.type !== 'number'))
                return `Expected numbers in array for "${propName}" (TYPE="${inputType}")`
            break
        }
        case 'color': {
            if (valueNode.type !== 'array')
                return `Expected an array [r, g, b, a] for "${propName}" (TYPE="${inputType}")`
            const items = (valueNode as ArrayASTNode).items
            if (items.length !== 4)
                return `Expected exactly 4 elements for "${propName}" (TYPE="${inputType}")`
            if (items.some(i => i.type !== 'number'))
                return `Expected numbers in array for "${propName}" (TYPE="${inputType}")`
            break
        }
    }
    return undefined
}

// Returns true if the node is on or directly inside a property key with the given name.
function isHoveringKey(node: ASTNode | undefined, keyName: string): boolean {
    if (!node) return false
    const prop = node.type === 'property' ? node as PropertyASTNode
        : node.parent?.type === 'property' ? node.parent as PropertyASTNode
        : undefined
    return prop !== undefined && (prop.keyNode as StringASTNode).value === keyName
}

// Check if the cursor node is inside the value of a PATH property within an IMPORTED entry.
// AST shape: root > IMPORTED (property) > {object value} > {name} (property) > {object value} > PATH (property) > string value
function isInsideImportedPath(node: ASTNode | undefined): boolean {
    if (!node) return false
    // The node should be a string value (or we're positioned inside one)
    let current: ASTNode | undefined = node
    // Walk up to find a property named PATH
    while (current) {
        if (current.type === 'property') {
            const prop = current as PropertyASTNode
            if ((prop.keyNode as StringASTNode).value === 'PATH') {
                // Now check that this PATH property is inside an IMPORTED entry
                // parent should be an object, whose parent is a property, whose parent is IMPORTED object
                const entryObj = prop.parent
                if (!entryObj || entryObj.type !== 'object') return false
                const entryProp = entryObj.parent
                if (!entryProp || entryProp.type !== 'property') return false
                const importedObj = entryProp.parent
                if (!importedObj || importedObj.type !== 'object') return false
                const importedProp = importedObj.parent
                if (!importedProp || importedProp.type !== 'property') return false
                return ((importedProp as PropertyASTNode).keyNode as StringASTNode).value === 'IMPORTED'
            }
        }
        current = current.parent
    }
    return false
}

// Common image file extensions supported by ISF runtimes and graphics frameworks.
const IMAGE_EXTENSIONS = new Set([
    // Raster basics
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.ico',
    // High dynamic range
    '.hdr', '.exr', '.rgbe',
    // TIFF
    '.tif', '.tiff',
    // Web formats
    '.webp', '.avif', '.heic', '.heif',
    // Adobe / design
    '.psd', '.psb',
    // GPU / compressed textures
    '.dds', '.ktx', '.ktx2', '.astc', '.pvr', '.basis',
    // Other
    '.svg', '.raw', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2',
    '.ppm', '.pgm', '.pbm', '.pfm',
    '.jp2', '.j2k', '.jpx',
    '.qoi',
])

function isImageFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) return true
    const extra: string[] = vscode.workspace.getConfiguration('isf').get('importedImageExtensions', [])
    return extra.some(e => ext === (e.startsWith('.') ? e.toLowerCase() : '.' + e.toLowerCase()))
}

// Generate file/directory completion items for IMPORTED PATH values.
function getFilePathCompletions(
    documentUri: vscode.Uri,
    doc: JSONTextDocument,
    offset: number,
): vscode.CompletionItem[] {
    const docDir = path.dirname(documentUri.fsPath)

    // Extract the partial path typed so far: text between the opening quote and cursor
    const text = doc.getText()
    // Walk back from offset to find the opening quote of the string value
    let quoteStart = offset - 1
    while (quoteStart >= 0 && text[quoteStart] !== '"') quoteStart--
    const partial = text.substring(quoteStart + 1, offset)

    // Determine which directory to list
    const partialDir = partial.includes('/') ? partial.substring(0, partial.lastIndexOf('/') + 1) : ''
    const resolvedDir = path.resolve(docDir, partialDir)

    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
    } catch {
        return []
    }

    const items: vscode.CompletionItem[] = []
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue

        if (entry.isDirectory()) {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Folder)
            item.insertText = entry.name + '/'
            item.command = { command: 'editor.action.triggerSuggest', title: '' }
            items.push(item)
        } else if (entry.isFile() && isImageFile(entry.name)) {
            const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.File)
            items.push(item)
        }
    }
    return items
}

function makeDiag(
    doc: JSONTextDocument,
    region: JsonRegion,
    node: ASTNode,
    message: string,
    severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic {
    const start = doc.positionAt(node.offset)
    const end = doc.positionAt(node.offset + node.length)
    return new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(region.startLine + start.line, start.character),
            new vscode.Position(region.startLine + end.line, end.character),
        ),
        message,
        severity,
    )
}
