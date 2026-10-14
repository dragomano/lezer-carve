/** Character classes and small scanners shared by the block and inline phases. */

export const isSpace = (c: number) => c === 32 || c === 9

/** ASCII space only. Carve's `space` terminal is `' '`, never a tab. */
export const isAsciiSpace = (c: number) => c === 32

/** Any C0/C1 whitespace we treat as a line terminator or filler. */
export const isWhitespace = (c: number) =>
  c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11

export const isDigit = (c: number) => c >= 48 && c <= 57

export const isUpperAlpha = (c: number) => c >= 65 && c <= 90

export const isLowerAlpha = (c: number) => c >= 97 && c <= 122

export const isAlpha = (c: number) => isUpperAlpha(c) || isLowerAlpha(c)

export const isAlnum = (c: number) => isAlpha(c) || isDigit(c)

/** ASCII punctuation, the set Carve allows after a backslash escape. */
export function isAsciiPunctuation(c: number): boolean {
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  )
}

/** Characters that may appear in a bare word (used to delimit spans). */
export function isWordChar(c: number): boolean {
  return isAlnum(c) || c === 95 /* _ */ || c > 127
}

/**
 * Index of the first occurrence of `needle` in `[from, to)`, or -1.
 *
 * `String.indexOf` has no end bound: asked for a `]` that does not come before
 * the construct's close, it scans on to the end of the document. In a parser
 * that asks at every `[`, `{` and `*`, one document with no links in it turns a
 * linear pass into a quadratic one — and the quadratic case is the common one,
 * because the delimiter being absent is exactly when the scan runs away.
 *
 * The loop is over the bounded range, and `startsWith` with a position does not
 * allocate.
 */
export function indexOf(text: string, needle: string, from: number, to: number): number {
  const last = to - needle.length
  for (let i = from; i <= last; i++) {
    if (text.startsWith(needle, i)) return i
  }
  return -1
}

/**
 * A flat view of the document with a line index.
 *
 * CodeMirror hands the parser an `Input` that only reads forward in chunks;
 * the block phase needs arbitrary lookahead (fence closers, container extents),
 * so the text is materialised once per parse.
 */
export class Source {
  readonly text: string
  /** Furthest character inspected while finding the current block's extent. */
  lookAhead = 0

  track(pos: number): void {
    if (pos > this.lookAhead) this.lookAhead = pos
  }
  /** Offset at which each line starts. Always starts with `0`. */
  readonly lineStarts: number[]
  /**
   * Length of a leading byte-order mark, which belongs to the encoding rather
   * than to the document. A file written by an editor that emits one starts
   * with U+FEFF, and without this every construct on the first line loses its
   * first character to it.
   */
  readonly bom: number

  constructor(text: string) {
    this.text = text
    this.bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
    const starts = [0]
    for (let i = this.bom; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) i++
        starts.push(i + 1)
      } else if (c === 10) starts.push(i + 1)
    }
    this.lineStarts = starts
  }

  get length(): number {
    return this.text.length
  }

  get lineCount(): number {
    return this.lineStarts.length
  }

  /**
   * The offset at which `line`'s content may begin: its start, or just past a
   * byte-order mark on the first line. Column arithmetic is measured from here,
   * so a leading BOM does not read as one column of indentation.
   */
  origin(line: number): number {
    return this.lineStarts[line] + (line === 0 ? this.bom : 0)
  }

  /** Index of the line containing `pos`. */
  lineAt(pos: number): number {
    const starts = this.lineStarts
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Offset one past the last character of `line`, excluding the newline. */
  lineEnd(line: number): number {
    const next = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : -1
    this.track(next < 0 ? this.length + 1 : next)
    // The last line of a document that does not end in a newline has no
    // terminator to step back over.
    if (next < 0) return this.text.length
    let end = next - 1 // drop LF or bare CR
    if (end > this.lineStarts[line] && this.text.charCodeAt(end - 1) === 13) end--
    return end
  }

  /** Offset of the last character of `line`'s terminator, or the document end. */
  lineBreak(line: number): number {
    return line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.text.length
  }

  /** The text of `line`, without its terminator. */
  lineText(line: number): string {
    return this.text.slice(this.lineStarts[line], this.lineEnd(line))
  }

  /**
   * Number of leading space characters on `line`, measured in columns. Tabs
   * count as one column each; Carve treats a tab in the leading run as an
   * ordinary whitespace character rather than a tab stop.
   */
  indentAt(line: number): number {
    const text = this.text
    let i = this.lineStarts[line]
    const end = this.lineEnd(line)
    if (line === 0) i += this.bom
    let col = 0
    while (
      i < end &&
      isWhitespace(text.charCodeAt(i)) &&
      text.charCodeAt(i) !== 10 &&
      text.charCodeAt(i) !== 13
    ) {
      i++
      col++
    }
    return col
  }

  /** True when the line holds nothing but whitespace. */
  isBlank(line: number): boolean {
    return this.indentAt(line) === this.lineEnd(line) - this.origin(line)
  }

  /** True when every character from `from` to the line end is whitespace. */
  restIsBlank(line: number, from: number): boolean {
    const text = this.text
    for (let i = from; i < this.lineEnd(line); i++) {
      if (!isWhitespace(text.charCodeAt(i))) return false
    }
    return true
  }

  /** The first non-whitespace offset at or after `from` on `line`. */
  skipSpaces(from: number, to: number): number {
    const text = this.text
    let i = from === 0 ? this.bom : from
    while (i < to && isWhitespace(text.charCodeAt(i))) i++
    return i
  }
}
