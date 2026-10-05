/**
 * Minimal, dependency-free YAML subset reader for the Delivery-Assured operation pack.
 *
 * It deliberately supports only the constructs the operation pack uses:
 *   - block mappings and block sequences (including `- key: value` rows)
 *   - flow sequences `[a, b]` and flow mappings `{a: 1}` (single or multi line)
 *   - plain, single-quoted and double-quoted scalars
 *   - literal (`|`) and folded (`>`) block scalars, with `-`/`+` chomping
 *   - `#` comments, blank lines, `---` document start
 *
 * Anything outside that subset throws a YamlError with a line number, so a
 * malformed Contract fails loudly instead of silently producing wrong facts.
 * This is intentionally not a general YAML implementation.
 */

export class YamlError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `${message} (line ${line + 1})`)
    this.name = 'YamlError'
    this.line = line
  }
}

const TRUE = new Set(['true', 'yes', 'on'])
const FALSE = new Set(['false', 'no', 'off'])
const NULL = new Set(['null', '~'])

/** Raw physical lines of the document currently being parsed. */
let scalarLines = []

/** Parse a YAML document into plain JavaScript values. */
export function parseYaml(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  scalarLines = src.split('\n')
  const tokens = tokenize(scalarLines)
  return parseBlock(tokens, 0, -1).value
}

/**
 * Split a document into content tokens.
 *
 * Every token keeps the line number it came from, so a parse error can always
 * name the offending line, and indentation is measured once here rather than at
 * each parse step. Blank lines, full-line comments and `---` markers carry no
 * content and are dropped.
 */
function tokenize(lines) {
  const tokens = []
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line]
    const indent = indentOf(raw)
    const content = stripComment(raw.slice(indent))
    if (content === '') continue
    if (/^---(\s|$)/.test(content) || /^\.\.\.(\s|$)/.test(content)) continue
    tokens.push({ indent, content, line })
  }
  return tokens
}

/** Parse the next block indented deeper than `parentIndent`. */
function parseBlock(tokens, i, parentIndent) {
  if (i >= tokens.length) return { value: null, next: tokens.length }
  const token = tokens[i]
  if (token.indent <= parentIndent) return { value: null, next: i }
  if (token.content === '-' || token.content.startsWith('- ')) return parseSequence(tokens, i, token.indent)
  return parseMapping(tokens, i, token.indent)
}

function parseSequence(tokens, i, indent) {
  const items = []
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.indent < indent) break
    if (token.indent > indent) throw new YamlError('unexpected indentation in sequence', token.line)
    if (token.content !== '-' && !token.content.startsWith('- ')) break

    const inline = token.content === '-' ? '' : token.content.slice(2).trim()
    if (inline === '') {
      const nested = parseBlock(tokens, i + 1, indent)
      items.push(nested.value)
      i = nested.next
      continue
    }
    // `- key: value` opens an entry on the same line as the dash: its
    // continuation keys line up one column past the dash, and a nested block for
    // its value is owned at the key's own indentation.
    const entryIndent = indent + 2
    if (looksLikeKey(inline)) {
      const entry = parseEntryAndSiblings(tokens, i, inline, entryIndent)
      items.push(entry.value)
      if (!entry.advanced) throw new YamlError('internal error: entry did not advance', token.line)
      i = entry.next
      continue
    }
    const scalar = parseInlineValue(inline, token.line, tokens, i)
    items.push(scalar.value)
    i = scalar.next
  }
  return { value: items, next: i }
}

function parseMapping(tokens, i, indent) {
  const out = {}
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.indent < indent) break
    if (token.indent > indent) throw new YamlError('unexpected indentation in mapping', token.line)
    if (token.content === '-' || token.content.startsWith('- ')) break
    if (!looksLikeKey(token.content)) {
      throw new YamlError(`expected a "key:" entry, found ${JSON.stringify(token.content)}`, token.line)
    }
    const keyEnd = findKeyEnd(token.content)
    const key = normalizeKey(unquote(token.content.slice(0, keyEnd).trim()))
    const entry = parseEntry(tokens, i, token.content, indent)
    out[key] = entry.value
    i = entry.next
  }
  return { value: out, next: i }
}

/**
 * Parse one `key: rest` entry beginning at token `i`, and return the value plus
 * the index of the next token to parse.
 *
 * `entryIndent` is the column where the key starts. It decides which following
 * lines still belong to this entry: a line indented deeper than `entryIndent`
 * either continues this mapping (equal indentation, e.g. the sibling keys of a
 * `- key: value` sequence row) or is the nested block owned by an empty value.
 */
function parseEntry(tokens, i, content, entryIndent) {
  const line = tokens[i].line
  const keyEnd = findKeyEnd(content)
  if (keyEnd === -1) throw new YamlError(`expected ":" in entry ${JSON.stringify(content)}`, line)
  const key = normalizeKey(unquote(content.slice(0, keyEnd).trim()))
  const rest = content.slice(keyEnd + 1).trim()

  if (rest === '') {
    const nested = parseBlock(tokens, i + 1, entryIndent)
    return { value: nested.value, next: nested.next, advanced: nested.next > i }
  }
  if (rest.startsWith('|') || rest.startsWith('>')) {
    const scalar = parseBlockScalar(tokens, i, rest, entryIndent, line)
    return { value: scalar.value, next: scalar.next, advanced: scalar.next > i }
  }
  return parseInlineValue(rest, line, tokens, i)
}

/**
 * Parse one sequence row that opens an entry on the dash line, e.g.
 * `- id: X`, together with the sibling keys that line up after the dash
 * (`    title: ...`). The row always yields an object, so a row with no siblings
 * still becomes `{ id: 'X' }` rather than a bare scalar.
 */
function parseEntryAndSiblings(tokens, i, content, entryIndent) {
  const first = parseEntry(tokens, i, content, entryIndent)
  const keyEnd = findKeyEnd(content)
  const out = { [normalizeKey(unquote(content.slice(0, keyEnd).trim()))]: first.value }
  let index = first.next
  for (;;) {
    if (index >= tokens.length) break
    const token = tokens[index]
    if (token.indent !== entryIndent) break
    if (token.content === '-' || token.content.startsWith('- ')) break
    if (!looksLikeKey(token.content)) break
    const sibling = parseEntry(tokens, index, token.content, entryIndent)
    if (sibling.next <= index) throw new YamlError('internal error: sibling did not advance', token.line)
    const siblingKeyEnd = findKeyEnd(token.content)
    out[normalizeKey(unquote(token.content.slice(0, siblingKeyEnd).trim()))] = sibling.value
    index = sibling.next
  }
  return { value: out, next: index, advanced: index > i }
}

/**
 * Read a literal (`|`) or folded (`>`) block scalar from the raw lines after the
 * header. Block scalars are the one construct whose content is not tokenized:
 * blank lines and `#` inside them are content, not comments.
 */
function parseBlockScalar(tokens, i, header, ownerIndent, line) {
  const rawLines = scalarLines
  const style = header[0]
  const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip'
  const collected = []
  let baseIndent = null
  let cursor = line + 1
  for (; cursor < rawLines.length; cursor += 1) {
    const raw = rawLines[cursor]
    if (raw.trim() === '') {
      collected.push('')
      continue
    }
    const ind = indentOf(raw)
    if (baseIndent === null) {
      if (ind <= ownerIndent) break
      baseIndent = ind
    }
    if (ind < baseIndent) break
    collected.push(raw.slice(baseIndent))
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  let text
  if (style === '|') {
    text = collected.join('\n')
    if (text !== '' || chomp === 'keep') text += '\n'
  } else {
    const parts = []
    let buffer = []
    for (const entry of collected) {
      if (entry === '') {
        parts.push(buffer.join(' '))
        buffer = []
      } else buffer.push(entry)
    }
    parts.push(buffer.join(' '))
    text = parts.join('\n')
    if (text !== '') text += '\n'
  }
  if (chomp === 'strip') text = text.replace(/\n+$/, '')
  // Resume at the first token whose line is past the consumed block.
  let next = i + 1
  while (next < tokens.length && tokens[next].line < cursor) next += 1
  return { value: text, next }
}

/**
 * Parse a single-line value and report where parsing resumes.
 *
 * A flow collection may continue on later lines; those lines are folded into one
 * text before parsing, so `parseFlow` always sees a complete collection.
 */
function parseInlineValue(raw, line, tokens = null, tokenIndex = -1) {
  const text = raw.trim()
  if (text.startsWith('[') || text.startsWith('{')) {
    let text2 = text
    let next = tokenIndex >= 0 ? tokenIndex + 1 : -1
    if (tokens && flowDelta(text) > 0) {
      let depth = flowDelta(text)
      let k = tokenIndex + 1
      const parts = [text]
      while (k < tokens.length && depth > 0) {
        parts.push(tokens[k].content)
        depth += flowDelta(tokens[k].content)
        k += 1
      }
      text2 = parts.join(' ')
      next = k
    }
    const [value, remainder, continued] = parseFlow(text2, line)
    if (continued) throw new YamlError('unterminated flow collection', line)
    if (remainder.trim() !== '') {
      throw new YamlError(`unexpected trailing content after flow value: ${JSON.stringify(remainder.trim())}`, line)
    }
    return {
      value,
      next: next >= 0 ? next : tokenIndex + 1,
      advanced: next >= 0 ? next > tokenIndex : true,
    }
  }
  return { value: parseScalar(text, line), next: tokenIndex >= 0 ? tokenIndex + 1 : -1, advanced: true }
}

/** Net bracket depth change contributed by one physical line. */
function flowDelta(line) {
  let depth = 0
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
  }
  return depth
}

function parseFlow(text, lineIndex) {
  let pos = 0
  let continued = false

  function skipWs() {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1
  }

  function readScalar(stopChars) {
    skipWs()
    if (text[pos] === '"' || text[pos] === "'") {
      const quote = text[pos]
      let out = ''
      pos += 1
      while (pos < text.length) {
        const ch = text[pos]
        if (quote === '"' && ch === '\\') {
          out += unescapeDouble(text[pos + 1])
          pos += 2
          continue
        }
        if (ch === quote) {
          if (quote === "'" && text[pos + 1] === "'") { out += "'"; pos += 2; continue }
          pos += 1
          return { raw: out, quoted: true }
        }
        out += ch
        pos += 1
      }
      throw new YamlError('unterminated quoted string in flow collection', lineIndex)
    }
    let out = ''
    while (pos < text.length && !stopChars.includes(text[pos])) { out += text[pos]; pos += 1 }
    return { raw: out.trim(), quoted: false }
  }

  function parseValue() {
    skipWs()
    if (text[pos] === '[') {
      pos += 1
      const arr = []
      for (;;) {
        skipWs()
        if (pos >= text.length) { continued = true; return arr }
        if (text[pos] === ']') { pos += 1; return arr }
        arr.push(parseValue())
        skipWs()
        if (text[pos] === ',') { pos += 1; continue }
        if (text[pos] === ']') { pos += 1; return arr }
        if (pos >= text.length) { continued = true; return arr }
        throw new YamlError(`unexpected character ${JSON.stringify(text[pos])} in flow sequence`, lineIndex)
      }
    }
    if (text[pos] === '{') {
      pos += 1
      const obj = {}
      for (;;) {
        skipWs()
        if (pos >= text.length) { continued = true; return obj }
        if (text[pos] === '}') { pos += 1; return obj }
        const key = readScalar(':,}')
        skipWs()
        if (text[pos] !== ':') throw new YamlError('expected ":" in flow mapping', lineIndex)
        pos += 1
        const value = parseValue()
        obj[normalizeKey(key.raw)] = value
        skipWs()
        if (text[pos] === ',') { pos += 1; continue }
        if (text[pos] === '}') { pos += 1; return obj }
        if (pos >= text.length) { continued = true; return obj }
        throw new YamlError(`unexpected character ${JSON.stringify(text[pos])} in flow mapping`, lineIndex)
      }
    }
    const scalar = readScalar(',]}')
    return scalar.quoted ? scalar.raw : parseScalar(scalar.raw, lineIndex)
  }

  const value = parseValue()
  return [value, text.slice(pos), continued]
}

function parseScalar(text, lineIndex) {
  const t = text.trim()
  if (t === '') return null
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new YamlError('unterminated double-quoted scalar', lineIndex)
    return unescapeDoubleBody(t.slice(1, -1))
  }
  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted scalar', lineIndex)
    return t.slice(1, -1).replace(/''/g, "'")
  }
  const lower = t.toLowerCase()
  if (TRUE.has(lower)) return true
  if (FALSE.has(lower)) return false
  if (NULL.has(lower)) return null
  if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10)
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return Number.parseFloat(t)
  return t
}

function unescapeDouble(ch) {
  switch (ch) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case '"': return '"'
    case '\\': return '\\'
    case '0': return '\0'
    case '/': return '/'
    default: return ch === undefined ? '' : ch
  }
}

function unescapeDoubleBody(body) {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') { out += unescapeDouble(body[i + 1]); i += 1; continue }
    out += body[i]
  }
  return out
}

function looksLikeKey(body) {
  return findKeyEnd(body) !== -1
}

/** Index of the `:` that separates key from value, or -1. */
function findKeyEnd(body) {
  let quote = null
  let depth = 0
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '[' || ch === '{') { depth += 1; continue }
    if (ch === ']' || ch === '}') { depth -= 1; continue }
    if (ch === ':' && depth === 0) {
      const next = body[i + 1]
      if (next === undefined || next === ' ' || next === '\t') return i
    }
  }
  return -1
}

function stripComment(body) {
  let quote = null
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(body[i - 1]))) return body.slice(0, i).trimEnd()
  }
  return body.trimEnd()
}

function indentOf(line) {
  const m = /^[ \t]*/.exec(line)
  return m[0].replace(/\t/g, '  ').length
}

function normalizeKey(key) {
  const t = key.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return unquote(t)
  }
  return t
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return unescapeDoubleBody(text.slice(1, -1))
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'")
  return text
}
