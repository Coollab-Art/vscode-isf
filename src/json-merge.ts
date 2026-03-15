// Parses ISF JSON text while merging duplicate top-level keys.
// Standard JSON.parse silently keeps only the last value for duplicate keys,
// which loses data. This module uses the vscode-json-languageservice AST to
// detect duplicates and merge them: arrays are concatenated, objects are merged,
// scalars use last-value-wins.
import {
    getLanguageService,
    TextDocument as JSONTextDocument,
    ObjectASTNode,
    ArrayASTNode,
    StringASTNode,
    PropertyASTNode,
} from 'vscode-json-languageservice'

// Top-level fields whose duplicate values should be concatenated (arrays)
const ARRAY_MERGE_FIELDS = new Set(['INPUTS', 'PASSES', 'CATEGORIES'])
// Top-level fields whose duplicate values should be shallow-merged (objects)
const OBJECT_MERGE_FIELDS = new Set(['IMPORTED'])

const ls = getLanguageService({})

/**
 * Parse ISF JSON text, merging duplicate top-level keys.
 * Returns the merged object, or falls back to plain JSON.parse if the AST
 * root is not an object. Throws on invalid JSON (same as JSON.parse).
 */
export function parseJsonMergingDuplicates(text: string): Record<string, unknown> {
    const doc = JSONTextDocument.create('isf://merge/tmp.json', 'json', 1, text)
    const parsed = ls.parseJSONDocument(doc)

    if (!parsed.root || parsed.root.type !== 'object') {
        return JSON.parse(text)
    }

    const root = parsed.root as ObjectASTNode

    // Group properties by key name, preserving order of first occurrence
    const groups = new Map<string, PropertyASTNode[]>()
    for (const prop of root.properties) {
        const key = (prop.keyNode as StringASTNode).value
        let group = groups.get(key)
        if (!group) {
            group = []
            groups.set(key, group)
        }
        group.push(prop)
    }

    // Check if there are any duplicates at all — fast path
    let hasDuplicates = false
    for (const [, props] of groups) {
        if (props.length > 1) { hasDuplicates = true; break }
    }
    if (!hasDuplicates) {
        return JSON.parse(text)
    }

    // Build merged result
    const result: Record<string, unknown> = {}
    for (const [key, props] of groups) {
        if (props.length === 1) {
            // Single occurrence — extract value directly
            result[key] = extractValue(text, props[0])
            continue
        }

        // Multiple occurrences — apply merge strategy
        if (ARRAY_MERGE_FIELDS.has(key)) {
            const merged: unknown[] = []
            for (const prop of props) {
                const val = extractValue(text, prop)
                if (Array.isArray(val)) {
                    merged.push(...val)
                } else {
                    // Non-array value for an array field — include as-is (schema validation will flag it)
                    result[key] = val
                }
            }
            if (!result.hasOwnProperty(key)) {
                result[key] = merged
            }
        } else if (OBJECT_MERGE_FIELDS.has(key)) {
            let merged: Record<string, unknown> = {}
            for (const prop of props) {
                const val = extractValue(text, prop)
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                    merged = { ...merged, ...(val as Record<string, unknown>) }
                } else {
                    // Non-object value for an object field — last wins
                    merged = val as any
                }
            }
            result[key] = merged
        } else {
            // Scalar / unknown field — last value wins
            result[key] = extractValue(text, props[props.length - 1])
        }
    }

    return result
}

function extractValue(text: string, prop: PropertyASTNode): unknown {
    if (!prop.valueNode) return undefined
    const raw = text.substring(prop.valueNode.offset, prop.valueNode.offset + prop.valueNode.length)
    try {
        return JSON.parse(raw)
    } catch {
        return undefined
    }
}
