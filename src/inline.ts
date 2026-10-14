import { CitationIndex, isCitationSpace } from "./citations.js"
import {
  indexOf,
  isAlnum,
  isAsciiPunctuation,
  isDigit,
  isSpace,
  isWhitespace,
  isWordChar,
  type Source
} from "./source.js"
import type { Ids } from "./terms.js"
import type { TreeBuilder } from "./tree-builder.js"

/**
 * Where in the block we are.
 *
 * `Top` is free text, where smart typography and bare `=` highlighting apply.
 * `InSpan` is a link label, cell or span, where most bare delimiters are inert
 * so that a URL like `/a/b` or a name like `a_b_c` is not mistaken for markup.
 */
export enum Context {
  Top = 0,
  InSpan = 1
}

/**
 * Phase 3 of the grammar: inline spans.
 *
 * Carve runs inline parsing over a finished block, so this never reasons about
 * block structure — it is handed one contiguous range and scans it left to
 * right. A construct is claimed only when its closer is found, which covers
 * every "needs content" clause in the spec (`{++}` is text, a lone `/` is text)
 * without a special case each.
 */
export class InlineParser {
  private readonly text: string
  private readonly ids: Ids
  private scanStart = 0
  private readonly failedClosers = new Map<string, number>()
  private readonly citationIndexes = new Map<number, { from: number; index: CitationIndex }>()
  private citationDepth = 0
  private readonly bracketMatches = new Map<
    number,
    { from: number; openers: Set<number>; matches: Map<number, number> }
  >()

  constructor(
    src: Source,
    private readonly b: TreeBuilder,
    ids: Ids,
    private readonly features: ReadonlySet<string>
  ) {
    this.text = src.text
    this.ids = ids
  }

  private id(name: string): number {
    return this.ids[name]
  }

  /** Parse `from`..`to`, wrapping the result in a `content` node. */
  run(from: number, to: number): void {
    if (to <= from) return
    this.failedClosers.clear()
    this.bracketMatches.clear()
    this.citationIndexes.clear()
    this.b.open(this.id("content"))
    this.scan(from, to, Context.Top)
    this.b.close(this.id("content"), from, to)
  }

  // ---------------------------------------------------------------------------

  private scan(from: number, to: number, ctx: Context): void {
    const previousStart = this.scanStart
    this.scanStart = from
    let i = from
    while (i < to) {
      const next = this.matchAt(i, to, ctx)
      if (next > i) i = next
      else if (this.text.charCodeAt(i) === 96) {
        // An unmatched opener remains one run; its suffix cannot open a
        // shorter verbatim span.
        do {
          i++
        } while (i < to && this.text.charCodeAt(i) === 96)
      } else i++
    }
    this.scanStart = previousStart
  }

  private atBoundary(i: number): boolean {
    return i === this.scanStart || i === 0 || !isWordChar(this.text.charCodeAt(i - 1))
  }

  /** A bare delimiter may open only at a word boundary and before non-space. */
  private openerOk(i: number, to: number): boolean {
    if (
      !this.atBoundary(i) ||
      (i > this.scanStart && this.text.charCodeAt(i - 1) === this.text.charCodeAt(i))
    )
      return false
    return i + 1 < to && !isWhitespace(this.text.charCodeAt(i + 1))
  }

  /**
   * Find the closer for a single-glyph delimiter, skipping escapes from `start`.
   * Returns the offset just past the closer, or -1. The closer must not be
   * preceded by a space, must not be doubled, and — for word-boundary
   * delimiters — must not be followed by a word character.
   */
  private findCloser(start: number, to: number, glyph: number, wordBoundary: boolean): number {
    const key = `${glyph}:${to}:${wordBoundary}`
    const failed = this.failedClosers.get(key)
    if (failed != null && start >= failed) return -1
    for (let j = start; j < to; j++) {
      if (this.text.charCodeAt(j) === 92 /* \ */) {
        j++
        continue
      }
      if (this.text.charCodeAt(j) !== glyph) continue
      if (j + 1 < to && this.text.charCodeAt(j + 1) === glyph) {
        do {
          j++
        } while (j + 1 < to && this.text.charCodeAt(j + 1) === glyph)
        continue
      }
      if (j > start && isWhitespace(this.text.charCodeAt(j - 1))) continue
      if (wordBoundary && j + 1 < to && isWordChar(this.text.charCodeAt(j + 1))) continue
      return j + 1
    }
    this.failedClosers.set(key, start)
    return -1
  }

  /**
   * Find the closing bracket matching the opener at `from`, skipping escapes.
   * Returns the offset of the closing bracket, or -1.
   */
  private findBracketed(from: number, to: number, open: string, close: string): number {
    if (open === "[") return this.squareBracketClose(from, to)
    let depth = 0
    for (let i = from; i < to; i++) {
      const c = this.text.charCodeAt(i)
      if (open === "(" && (c === 34 || c === 39) && isWhitespace(this.text.charCodeAt(i - 1))) {
        const end = this.findGlyph(i + 1, to, c)
        if (end < 0) return -1
        i = end
        continue
      }
      if (this.text.charCodeAt(i) === 92 /* \ */) {
        i++
        continue
      }
      if (this.text.startsWith(open, i)) {
        depth++
        i += open.length - 1
        continue
      }
      if (this.text.startsWith(close, i)) {
        if (depth === 0) return -1
        depth--
        i += close.length - 1
        if (depth === 0) return i
      }
    }
    return -1
  }

  /** Pair square brackets once per scan boundary, including unmatched openers. */
  private squareBracketClose(from: number, to: number): number {
    let cached = this.bracketMatches.get(to)
    // An earlier lookahead may have skipped this opener inside a verbatim
    // run. The actual scan can reach it through a different enclosing span.
    if (!cached || from < cached.from || !cached.openers.has(from)) {
      const matches = new Map<number, number>()
      const openers = new Set<number>()
      const stack: number[] = []
      for (let i = from; i < to; i++) {
        const c = this.text.charCodeAt(i)
        if (c === 92) i++
        else if (c === 96) {
          let width = 1
          while (i + width < to && this.text.charCodeAt(i + width) === 96) width++
          const end = this.backtickClose(i + width, to, width)
          i = end < 0 ? i + width - 1 : end + width - 1
        } else if (c === 91) {
          openers.add(i)
          stack.push(i)
        } else if (c === 93) {
          const start = stack.pop()
          if (start != null) matches.set(start, i)
        }
      }
      cached = { from, openers, matches }
      this.bracketMatches.set(to, cached)
    }
    return cached.matches.get(from) ?? -1
  }

  /** Find the first `glyph` at or after `from`, skipping escapes. */
  private findGlyph(from: number, to: number, glyph: number): number {
    for (let i = from; i < to; i++) {
      const c = this.text.charCodeAt(i)
      if (c === 92 /* \ */) {
        i++
        continue
      }
      if (c === glyph) return i
    }
    return -1
  }

  /** A complete delimiter inside this range, excluding escaped occurrences. */
  private findDelimiter(from: number, to: number, delimiter: string): number {
    const key = `${delimiter}:${to}`
    const failed = this.failedClosers.get(key)
    if (failed != null && from >= failed) return -1
    for (let i = from; i <= to - delimiter.length; i++) {
      if (this.text.charCodeAt(i) === 92) i++
      else if (this.text.startsWith(delimiter, i)) return i
    }
    this.failedClosers.set(key, from)
    return -1
  }

  /**
   * A span whose opener and closer share a glyph: `/italic/`, `*bold*`,
   * `_underline_`, `~strike~`, `=highlight=`.
   */
  private symmetric(
    i: number,
    to: number,
    ctx: Context,
    glyph: string,
    wrap: string,
    begin: string,
    end: string
  ): number {
    if (!this.openerOk(i, to)) return -1
    const code = glyph.charCodeAt(0)
    const contentStart = i + 1
    if (this.text.charCodeAt(contentStart) === code) return -1 // doubled delimiter
    const close = this.findCloser(contentStart, to, code, true)
    if (close <= contentStart + 1) return -1 // needs at least one content character
    this.b.open(this.id(wrap))
    this.b.token(this.id(begin), i, contentStart)
    this.scan(contentStart, close - 1, ctx)
    this.b.token(this.id(end), close - 1, close)
    this.b.close(this.id(wrap), i, close)
    return close
  }

  /**
   * `{^x^}`, `{,x,}`, `{+x+}`, `{-x-}` — opener and closer share a glyph.
   *
   * Unlike the bare delimiters these need no word boundary: the braces are
   * self-delimiting, which is what lets `super{^script^}` read as a superscript
   * rather than as a brace.
   */
  private braced(
    i: number,
    to: number,
    ctx: Context,
    wrap: string,
    glyph: string,
    begin: string,
    end: string
  ): number {
    const contentStart = i + 2
    if (contentStart >= to || isSpace(this.text.charCodeAt(contentStart))) return -1
    const close = this.findDelimiter(contentStart, to, `${glyph}}`)
    if (close < 0 || close <= contentStart) return -1
    this.b.open(this.id(wrap))
    this.b.token(this.id(begin), i, contentStart)
    this.scan(contentStart, close, ctx)
    this.b.token(this.id(end), close, close + 2)
    this.b.close(this.id(wrap), i, close + 2)
    return close + 2
  }

  // ---------------------------------------------------------------------------

  private matchAt(i: number, to: number, ctx: Context): number {
    const text = this.text
    const c = text.charCodeAt(i)
    if (ctx === Context.InSpan) {
      // Inside a span only a conservative subset can open.
      switch (c) {
        case 92:
          return this.escape(i, to)
        case 96:
          return this.backticks(i, to, "verbatim", "verbatim_marker_begin", "verbatim_marker_end")
        case 123:
          return this.brace(i, to, ctx)
        case 47:
          return this.slash(i, to, ctx)
        case 42:
          return this.star(i, to, ctx)
        case 95:
          return this.symmetric(i, to, ctx, "_", "underline", "underline_begin", "underline_end")
        case 126:
          return this.symmetric(
            i,
            to,
            ctx,
            "~",
            "strikethrough",
            "strikethrough_begin",
            "strikethrough_end"
          )
        default:
          return -1
      }
    }
    switch (c) {
      case 92 /* \ */:
        return this.escape(i, to)
      case 96 /* ` */:
        return this.backticks(i, to, "verbatim", "verbatim_marker_begin", "verbatim_marker_end")
      case 33 /* ! */:
        return this.bang(i, to, ctx)
      case 36 /* $ */:
        return this.math(i, to)
      case 123 /* { */:
        return this.brace(i, to, ctx)
      case 91 /* [ */:
        return this.openBracket(i, to, ctx, false)
      case 60 /* < */:
        return this.angle(i, to)
      case 94 /* ^ */:
        return text.charCodeAt(i + 1) === 91 ? this.inlineNote(i, to) : -1
      case 58 /* : */:
        return this.colon(i, to)
      case 64 /* @ */:
        return this.mention(i, to)
      case 35 /* # */:
        return this.tag(i, to)
      case 47 /* / */:
        return this.slash(i, to, ctx)
      case 42 /* * */:
        return this.star(i, to, ctx)
      case 95 /* _ */:
        return this.symmetric(i, to, ctx, "_", "underline", "underline_begin", "underline_end")
      case 126 /* ~ */:
        return this.symmetric(
          i,
          to,
          ctx,
          "~",
          "strikethrough",
          "strikethrough_begin",
          "strikethrough_end"
        )
      case 61 /* = */:
        return this.symmetric(
          i,
          to,
          ctx,
          "=",
          "highlighted",
          "highlighted_begin",
          "highlighted_end"
        )
      case 46 /* . */:
        return this.ellipsis(i, to)
      case 45 /* - */:
        return this.dash(i, to)
      case 34 /* " */:
      case 39 /* ' */:
        return this.quotes(i, to)
      default:
        return -1
    }
  }

  // --- escapes and typography -------------------------------------------------

  private escape(i: number, to: number): number {
    // The escaped character has to lie inside the range being scanned. Without
    // this a `\` at the end of a table cell swallows the cell's closing `|`
    // and the token reaches outside its own parent.
    if (i + 1 >= to) return -1
    const next = this.text.charCodeAt(i + 1)
    if (next === 10 /* LF */ || next === 13 /* CR */) {
      const end = i + (next === 13 && i + 2 < to && this.text.charCodeAt(i + 2) === 10 ? 3 : 2)
      this.b.token(this.id("hard_line_break"), i, end)
      return end
    }
    if (next === 32 /* space */ || next === 9 /* tab */) {
      // `\ ` is a no-break space mid-line and a hard break in the last column.
      this.b.token(this.id("hard_line_break"), i, i + 2)
      return i + 2
    }
    if (isAsciiPunctuation(next)) {
      this.b.token(this.id("backslash_escape"), i, i + 2)
      return i + 2
    }
    return -1
  }

  private ellipsis(i: number, to: number): number {
    if (i === 0 || isWordChar(this.text.charCodeAt(i - 1))) return -1
    if (!this.text.startsWith("...", i)) return -1
    if (i + 3 < to && isWordChar(this.text.charCodeAt(i + 3))) return -1
    this.b.token(this.id("ellipsis"), i, i + 3)
    return i + 3
  }

  /**
   * Smart dashes: a run flanked by digits is an en dash (a numeric range), two
   * or more hyphens elsewhere are an em dash, and a lone hyphen between spaces
   * is an en dash. Anything else is a hyphen or a list marker.
   */
  private dash(i: number, to: number): number {
    const n = this.runHyphens(i)
    if (n === 0) return -1
    const after = i + n
    if (after >= to) return -1
    const before = i === 0 ? -1 : this.text.charCodeAt(i - 1)
    const next = this.text.charCodeAt(after)
    const range = isDigit(before) && isDigit(next)
    let node: string
    if (range) node = "en_dash"
    else if (n >= 2) node = "em_dash"
    else if (isSpace(before) && isSpace(next)) node = "en_dash"
    else return -1
    this.b.token(this.id(node), i, after)
    return after
  }

  private runHyphens(from: number): number {
    let n = 0
    while (this.text.charCodeAt(from + n) === 45 /* - */) n++
    return n
  }

  private quotes(i: number, to: number): number {
    const c = this.text.charCodeAt(i)
    if (i > 0 && !isSpace(this.text.charCodeAt(i - 1))) return -1
    if (i + 1 >= to || isSpace(this.text.charCodeAt(i + 1))) return -1
    for (let j = i + 1; j < to; j++) {
      if (this.text.charCodeAt(j) === 10) break
      if (this.text.charCodeAt(j) === c && !isSpace(this.text.charCodeAt(j - 1))) {
        this.b.token(this.id("quotation_marks"), i, j + 1)
        return j + 1
      }
    }
    return -1
  }

  // --- opaque payloads --------------------------------------------------------

  /**
   * A run of N backticks closes only on a run of exactly N. Used by both
   * `` `verbatim` `` and ``!`literal` ``, which differ only in their marker.
   */
  private backtickRun(
    i: number,
    to: number,
    wrap: string,
    begin: string,
    end: string,
    markerStart: number
  ): number {
    const text = this.text
    let n = 0
    while (markerStart + n < to && text.charCodeAt(markerStart + n) === 96) n++
    const contentStart = markerStart + n
    const close = this.backtickClose(contentStart, to, n)
    if (close < 0) return -1
    this.b.open(this.id(wrap))
    this.b.token(this.id(begin), i, contentStart)
    this.raw(contentStart, close)
    this.b.token(this.id(end), close, close + n)
    this.b.close(this.id(wrap), i, close + n)
    return close + n
  }

  /** Find a matching run without emitting nodes, also used in link labels. */
  private backtickClose(from: number, to: number, width: number): number {
    const text = this.text
    for (let j = from; j < to; j++) {
      if (text.charCodeAt(j) !== 96) continue
      let m = 0
      while (j + m < to && text.charCodeAt(j + m) === 96) m++
      if (m !== width) {
        j += m - 1
        continue
      }
      return j
    }
    return -1
  }

  private backticks(i: number, to: number, wrap: string, begin: string, end: string): number {
    return this.backtickRun(i, to, wrap, begin, end, i)
  }

  /** Verbatim and math payloads are opaque: no nested markup is recognised. */
  private raw(from: number, to: number): void {
    if (to > from) this.b.token(this.id("content"), from, to)
  }

  /** The next unescaped pipe outside a complete verbatim run on this row. */
  cellEnd(from: number, to: number): number {
    for (let i = from; i < to; i++) {
      const c = this.text.charCodeAt(i)
      if (c === 92 && i + 1 < to && isAsciiPunctuation(this.text.charCodeAt(i + 1))) i++
      else if (c === 96) {
        let width = 1
        while (i + width < to && this.text.charCodeAt(i + width) === 96) width++
        const close = this.backtickClose(i + width, to, width)
        i = close < 0 ? i + width - 1 : close + width - 1
      } else if (c === 124) return i
    }
    return to
  }

  private bang(i: number, to: number, ctx: Context): number {
    const next = this.text.charCodeAt(i + 1)
    if (next === 96 /* ` */) {
      return this.backtickRun(
        i,
        to,
        "inline_literal",
        "literal_marker_begin",
        "literal_marker_end",
        i + 1
      )
    }
    if (next === 91 /* [ */) {
      return this.openBracket(i + 1, to, ctx, true)
    }
    return -1
  }

  /** ``$`inline math` `` and the `$$`…`` ``` display form. */
  private math(i: number, to: number): number {
    let dollars = 0
    while (i + dollars < to && this.text.charCodeAt(i + dollars) === 36) dollars++
    if (this.text.charCodeAt(i + dollars) !== 96) return -1
    return this.backtickRun(i, to, "math", "math_marker_begin", "math_marker_end", i + dollars)
  }

  // --- braces -----------------------------------------------------------------

  private brace(i: number, to: number, ctx: Context): number {
    const text = this.text
    switch (text.charCodeAt(i + 1)) {
      case 94 /* ^ */:
        return this.braced(i, to, ctx, "superscript", "^", "superscript_begin", "superscript_end")
      case 44 /* , */:
        return this.braced(i, to, ctx, "subscript", ",", "subscript_begin", "subscript_end")
      case 43 /* + */:
        return this.braced(i, to, ctx, "insert", "+", "insert_begin", "insert_end")
      case 45 /* - */:
        if (text.charCodeAt(i + 2) === 125 /* } */) {
          // `{-}` is the braced en dash: a construct in its own right.
          this.b.token(this.id("en_dash"), i, i + 3)
          return i + 3
        }
        return this.braced(i, to, ctx, "delete", "-", "delete_begin", "delete_end")
      case 126 /* ~ */:
        return this.substitution(i, to)
      case 35 /* # */:
        {
          // `{#…#}` is a comment, but `{#id}` is an ordinary id attribute.
          const comment = this.editorialComment(i, to)
          return comment > 0 ? comment : this.attribute(i, to, "inline_attribute")
        }
      case 37 /* % */:
        return this.bracedComment(i, to)
      case 61 /* = */:
        return this.rawInline(i, to)
      default:
        return this.attribute(i, to, "inline_attribute")
    }
  }

  /** `{~old~>new~}` — two payloads separated by `>`. */
  private substitution(i: number, to: number): number {
    if (!this.openerOk(i, to)) return -1
    let arrow = -1
    for (let j = i + 2; j + 1 < to; j++) {
      if (this.text.charCodeAt(j) === 62 /* > */ && this.text.charCodeAt(j - 1) === 126 /* ~ */) {
        arrow = j
        break
      }
    }
    if (arrow < 0) return -1
    const close = indexOf(this.text, "~}", arrow + 1, to)
    if (close < 0 || close >= to || close <= arrow + 1) return -1
    this.b.open(this.id("substitution"))
    this.raw(i + 2, arrow - 1)
    this.raw(arrow + 1, close)
    this.b.close(this.id("substitution"), i, close + 2)
    return close + 2
  }

  /** `{#a note for the reader#}` — CriticMarkup's rendered comment. */
  private editorialComment(i: number, to: number): number {
    const close = indexOf(this.text, "#}", i + 2, to)
    if (close < 0 || close >= to || close <= i + 2) return -1
    this.b.open(this.id("editorial_comment"))
    this.raw(i + 2, close)
    this.b.close(this.id("editorial_comment"), i, close + 2)
    return close + 2
  }

  /** `{% hidden from readers %}`. */
  private bracedComment(i: number, to: number): number {
    const close = indexOf(this.text, "%}", i + 2, to)
    if (close < 0 || close >= to) return -1
    this.b.open(this.id("braced_comment"))
    this.raw(i + 2, close)
    this.b.close(this.id("braced_comment"), i, close + 2)
    return close + 2
  }

  /** `{=html}` … `{=html}`: raw content for a named output format. */
  private rawInline(i: number, to: number): number {
    if (!this.features.has("raw")) return -1
    const close = indexOf(this.text, "}", i + 2, to)
    if (close < 0 || close >= to) return -1
    const name = this.text.slice(i + 2, close)
    if (!/^[a-z][a-z0-9+.-]*$/i.test(name)) return -1
    const hit = indexOf(this.text, `{=${name}}`, close + 1, to)
    if (hit < 0 || hit >= to) return -1
    const end = hit + name.length + 3
    this.b.open(this.id("raw_inline"))
    this.b.open(this.id("raw_inline_marker_begin"))
    this.b.token(this.id("raw_inline_marker_begin"), i, i + 2)
    this.b.token(this.id("raw_inline_attribute"), i + 2, close)
    this.b.close(this.id("raw_inline_marker_begin"), i, close + 1)
    this.raw(close + 1, hit)
    this.b.open(this.id("raw_inline_marker_end"))
    this.b.token(this.id("raw_inline_marker_end"), hit, hit + 2)
    this.b.token(this.id("raw_inline_attribute"), hit + 2, hit + 2 + name.length)
    this.b.close(this.id("raw_inline_marker_end"), hit, end)
    this.b.close(this.id("raw_inline"), i, end)
    return end
  }

  // --- attributes -------------------------------------------------------------

  /**
   * `{#id .class key=value flag :lang}`, inline or on a line of its own.
   * Returns the offset past the closing brace, or -1 when this is not an
   * attribute block — which is how `{^^}` and friends stay text.
   */
  attribute(i: number, to: number, node: string): number {
    if (this.text.charCodeAt(i) !== 123 /* { */) return -1
    const close = this.attributeEnd(i, to)
    if (close < 0) return -1
    this.b.open(this.id(node))
    this.scanAttributes(i + 1, close - 1)
    this.b.close(this.id(node), i, close)
    return close
  }

  /** End offset (past `}`) of the attribute block starting at `i`. */
  attributeEnd(i: number, to: number): number {
    const text = this.text
    const key = `}:${to}`
    const failed = this.failedClosers.get(key)
    if (failed != null && i >= failed) return -1
    if (indexOf(text, "}", i + 1, to) < 0) {
      this.failedClosers.set(key, i)
      return -1
    }
    let quote = 0
    for (let j = i + 1; j < to; j++) {
      const c = text.charCodeAt(j)
      if (c === 10 || c === 13) return -1
      if (quote) {
        if (c === 92 /* \ */ && isAsciiPunctuation(text.charCodeAt(j + 1))) j++
        else if (c === quote) quote = 0
        continue
      }
      if (c === 34 || c === 39) quote = c
      else if (c === 125 /* } */) {
        // `{#…#}` is a CriticMarkup comment, not an id attribute.
        if (text.charCodeAt(j - 1) === 35 && text.charCodeAt(i + 1) === 35) return -1
        // The body has to look like attributes; `{^x^}` and `{--}` are spans.
        return this.isAttributeBody(i + 1, j) ? j + 1 : -1
      }
    }
    return -1
  }

  /** Every item in a `{...}` block must start the way an attribute starts. */
  private isAttributeBody(from: number, to: number): boolean {
    const text = this.text
    let i = from
    let items = 0
    while (i < to) {
      while (i < to && isSpace(text.charCodeAt(i))) i++
      if (i >= to) break
      const c = text.charCodeAt(i)
      const startsItem =
        c === 35 /* # */ ||
        c === 46 /* . */ ||
        isAlnum(c) ||
        c === 45 /* - */ ||
        c === 95 /* _ */ ||
        (c === 58 /* : */ && i + 1 < to && isAlnum(text.charCodeAt(i + 1)))
      if (!startsItem) return false
      i = this.attributeItemEnd(i, to)
      items++
    }
    return items > 0
  }
  private scanAttributes(from: number, to: number): void {
    const text = this.text
    let i = from
    while (i < to) {
      while (i < to && isSpace(text.charCodeAt(i))) i++
      if (i >= to) break
      const start = i
      const c = text.charCodeAt(i)
      let node: string
      if (c === 35 /* # */) {
        node = "identifier"
      } else if (c === 46 /* . */) {
        node = "class_name"
      } else if (c === 58 /* : */ && isAlnum(text.charCodeAt(i + 1))) {
        node = "language_attribute"
      } else if (isAlnum(c) || c === 45 /* - */ || c === 95 /* _ */) {
        // `key=value` is a pair; a bare key is a consumed boolean attribute.
        node =
          indexOf(text, "=", start, this.attributeItemEnd(start, to)) >= 0
            ? "key_value"
            : "boolean_attribute"
      } else {
        i++
        continue
      }
      const end = this.attributeItemEnd(start, to)
      if (node === "key_value") {
        const eq = indexOf(text, "=", start, end)
        this.b.open(this.id("key_value"))
        this.b.token(this.id("key"), start, eq)
        // `lang= fr` is an empty language attribute followed by a separate
        // boolean, and an empty attribute has no characters to point at. Lezer
        // has no way to say "present but empty", so the pair carries its key
        // alone and the value node is left out rather than emitted empty.
        if (end > eq + 1) this.b.token(this.id("value"), eq + 1, end)
        this.b.close(this.id("key_value"), start, end)
      } else {
        this.b.token(this.id(node), start, end)
      }
      i = end
    }
  }

  private attributeItemEnd(from: number, to: number): number {
    const text = this.text
    let i = from + 1
    while (i < to && !isSpace(text.charCodeAt(i))) {
      const c = text.charCodeAt(i)
      if (c === 34 || c === 39) {
        i++
        while (i < to && text.charCodeAt(i) !== c) {
          if (text.charCodeAt(i) === 92 && i + 1 < to) i++
          i++
        }
      }
      i++
    }
    return i
  }

  // --- links ------------------------------------------------------------------

  private openBracket(i: number, to: number, ctx: Context, image: boolean): number {
    const text = this.text
    const from = image ? i - 1 : i
    if (text.charCodeAt(i) !== 91 /* [ */) return -1
    if (!image && text.charCodeAt(i + 1) === 94 /* ^ */) return this.footnoteRef(i, to)
    const inner = i + 1
    if (inner >= to || text.charCodeAt(inner) === 93 /* ] */) return -1
    const close = this.findBracketed(i, to, "[", "]")
    if (close < 0 || close <= inner) return -1

    if (text.charCodeAt(close + 1) === 40 /* ( */) {
      const dest = this.findBracketed(close + 1, to, "(", ")")
      if (dest < 0 || dest <= close + 2) return -1
      return this.inlineLink(
        from,
        dest + 1,
        image ? "inline_image" : "inline_link",
        inner,
        close,
        close + 1,
        dest
      )
    }
    if (text.charCodeAt(close + 1) === 91 /* [ */) {
      const label = this.findBracketed(close + 1, to, "[", "]")
      if (label < 0) return -1
      // Consume the reserved label with its first pair, so [text][@key]
      // cannot turn its rejected tail into a standalone citation.
      if (text.charCodeAt(close + 2) === 64) return label + 1
      const collapsed = close + 2 === label // `[]`
      if (collapsed && text.charCodeAt(inner) === 64) return label + 1
      const node = collapsed
        ? image
          ? "collapsed_reference_image"
          : "collapsed_reference_link"
        : image
          ? "full_reference_image"
          : "full_reference_link"
      if (collapsed) return this.bareLink(from, label + 1, node, inner, close)
      return this.referenceLink(from, label + 1, node, inner, close, label)
    }
    // `[text]` followed by `{…}` is a semantic span, not a reference link.
    const probe = close + 1
    const attrEnd = !image && text.charCodeAt(probe) === 123 ? this.attributeEnd(probe, to) : -1
    if (attrEnd > 0) {
      this.b.open(this.id("span"))
      this.b.token(this.id("link_mark"), i, inner)
      this.scan(inner, close, ctx)
      this.b.token(this.id("link_mark"), close, close + 1)
      this.b.close(this.id("span"), i, close + 1)
      this.attribute(probe, attrEnd, "inline_attribute")
      return attrEnd
    }
    if (!image && this.features.has("citations")) {
      // Any link/ref/span tail owns the brackets, including an unfinished tail.
      if (text.charCodeAt(probe) === 123) return -1
      const citation = this.citation(i, close, to)
      if (citation > 0) return citation
      if (this.citationIndex(i, to).containsKey(inner, close)) return -1
    }
    if (text.charCodeAt(inner) === 64) return close + 1
    return this.bareLink(
      from,
      close + 1,
      image ? "collapsed_reference_image" : "collapsed_reference_link",
      inner,
      close
    )
  }

  private citationIndex(from: number, to: number): CitationIndex {
    let cached = this.citationIndexes.get(to)
    if (!cached || from < cached.from) {
      cached = { from, index: new CitationIndex(this.text, from, to) }
      this.citationIndexes.set(to, cached)
    }
    return cached.index
  }

  private citation(i: number, close: number, to: number): number {
    if (this.citationDepth >= 128) return -1
    const inner = i + 1 + (this.text.charCodeAt(i + 1) === 43 ? 1 : 0)
    const items = this.citationIndex(i, to).items(inner, close)
    if (!items) return -1
    this.citationDepth++
    this.b.open(this.id("citation_group"))
    this.b.token(this.id("link_mark"), i, inner)
    for (let n = 0; n < items.length; n++) {
      const item = items[n]
      let mark = item.at
      if (this.text.charCodeAt(mark - 1) === 45) {
        let escapes = 0
        for (let j = mark - 2; j >= item.from && this.text.charCodeAt(j) === 92; j--) escapes++
        if (escapes % 2 === 0) mark--
      }
      let prefixTo = mark
      while (prefixTo > item.from && isCitationSpace(this.text.charCodeAt(prefixTo - 1))) prefixTo--
      this.citationContent(item.from, prefixTo)
      this.b.token(this.id("link_mark"), mark, item.at + 1)
      this.b.token(this.id("citation_label"), item.at + 1, item.end)
      if (this.text.charCodeAt(item.end) === 44 && item.end < item.to) {
        this.b.token(this.id("link_mark"), item.end, item.end + 1)
        let locator = item.end + 1
        while (locator < item.to && isCitationSpace(this.text.charCodeAt(locator))) locator++
        this.citationContent(locator, item.to)
      }
      if (n + 1 < items.length) {
        const separator = indexOf(this.text, ";", item.to, items[n + 1].from)
        this.b.token(this.id("link_mark"), separator, separator + 1)
      }
    }
    this.b.token(this.id("link_mark"), close, close + 1)
    this.b.close(this.id("citation_group"), i, close + 1)
    this.citationDepth--
    return close + 1
  }

  private citationContent(from: number, to: number): void {
    if (from >= to) return
    this.b.open(this.id("content"))
    this.scan(from, to, Context.Top)
    this.b.close(this.id("content"), from, to)
  }

  /** `[text](dest)` — `parenOpen`/`parenClose` bracket the destination. */
  private inlineLink(
    i: number,
    end: number,
    node: string,
    textFrom: number,
    textTo: number,
    parenOpen: number,
    parenClose: number
  ): number {
    // The payload may carry a quoted title after the destination. Search only
    // the payload: a quote later in the document is not this link's title.
    let quote = -1
    for (let j = parenOpen + 1; j < parenClose; j++) {
      const c = this.text.charCodeAt(j)
      if (c === 92) j++
      else if ((c === 34 || c === 39) && isWhitespace(this.text.charCodeAt(j - 1))) {
        quote = j
        break
      }
    }
    const titleEnd =
      quote >= 0 ? this.findGlyph(quote + 1, parenClose, this.text.charCodeAt(quote)) : -1
    if (titleEnd < 0) quote = -1
    let destTo = quote >= 0 ? quote : parenClose
    while (destTo > parenOpen + 1 && isSpace(this.text.charCodeAt(destTo - 1))) destTo--
    this.b.open(this.id(node))
    this.b.token(this.id("link_mark"), i, textFrom)
    this.b.open(this.id("link_text"))
    this.scan(textFrom, textTo, Context.InSpan)
    this.b.close(this.id("link_text"), textFrom, textTo)
    this.b.token(this.id("link_mark"), textTo, parenOpen + 1)
    this.b.open(this.id("inline_link_destination"))
    this.scan(parenOpen + 1, destTo, Context.InSpan)
    this.b.close(this.id("inline_link_destination"), parenOpen + 1, destTo)
    if (quote >= 0) {
      this.b.open(this.id("link_title"))
      this.scan(quote + 1, titleEnd, Context.InSpan)
      this.b.close(this.id("link_title"), quote + 1, titleEnd)
    }
    this.b.token(this.id("link_mark"), parenClose, end)
    this.b.close(this.id(node), i, end)
    return end
  }

  /** `[text][label]` — the second bracket pair holds the reference label. */
  private referenceLink(
    i: number,
    end: number,
    node: string,
    textFrom: number,
    textTo: number,
    labelClose: number
  ): number {
    const labelFrom = textTo + 2 // just past the `[` that opens the label
    this.b.open(this.id(node))
    this.b.token(this.id("link_mark"), i, textFrom)
    this.b.open(this.id("link_text"))
    this.scan(textFrom, textTo, Context.InSpan)
    this.b.close(this.id("link_text"), textFrom, textTo)
    this.b.token(this.id("link_mark"), textTo, labelFrom)
    this.b.open(this.id("link_label"))
    this.scan(labelFrom, labelClose, Context.InSpan)
    this.b.close(this.id("link_label"), labelFrom, labelClose)
    this.b.token(this.id("link_mark"), labelClose, end)
    this.b.close(this.id(node), i, end)
    return end
  }

  /** `[text]` and `[text][]` — nothing follows the first bracket pair. */
  private bareLink(i: number, end: number, node: string, textFrom: number, textTo: number): number {
    this.b.open(this.id(node))
    this.b.token(this.id("link_mark"), i, textFrom)
    this.b.open(this.id("link_text"))
    this.scan(textFrom, textTo, Context.InSpan)
    this.b.close(this.id("link_text"), textFrom, textTo)
    this.b.token(this.id("link_mark"), textTo, end)
    this.b.close(this.id(node), i, end)
    return end
  }

  private footnoteRef(i: number, to: number): number {
    const close = indexOf(this.text, "]", i + 2, to)
    if (close < 0 || close >= to || close <= i + 2) return -1
    this.b.open(this.id("footnote_reference"))
    this.b.open(this.id("reference_label"))
    this.scan(i + 2, close, Context.InSpan)
    this.b.close(this.id("reference_label"), i + 2, close)
    this.b.close(this.id("footnote_reference"), i, close + 1)
    return close + 1
  }

  private inlineNote(i: number, to: number): number {
    const open = indexOf(this.text, "[", i + 1, to)
    if (open < 0 || open >= to) return -1
    const close = this.findBracketed(open, to, "[", "]")
    if (close < 0 || close <= open + 1) return -1
    this.b.open(this.id("inline_note"))
    this.b.token(this.id("link_mark"), i, open + 1)
    this.scan(open + 1, close, Context.InSpan)
    this.b.token(this.id("link_mark"), close, close + 1)
    this.b.close(this.id("inline_note"), i, close + 1)
    return close + 1
  }

  /** `<https://…>` and `</#section-id>` / `</file.md#section>`. */
  private angle(i: number, to: number): number {
    const text = this.text
    const key = `>:${to}`
    const failed = this.failedClosers.get(key)
    if (failed != null && i >= failed) return -1
    const close = indexOf(text, ">", i + 1, to)
    if (close < 0) {
      this.failedClosers.set(key, i)
      return -1
    }
    const body = text.slice(i + 1, close)
    if (/^\/(?:[^ <>#\r\n]+)?#[^ <>#\r\n]+$/.test(body)) {
      this.b.open(this.id("auto_text_link"))
      this.raw(i + 2, close)
      this.b.close(this.id("auto_text_link"), i, close + 1)
      return close + 1
    }
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:.+$/.test(body)
    const email = /^[A-Za-z0-9._+-]+@[A-Za-z0-9._+-]+\.[A-Za-z]+$/.test(body)
    if ((!url && !email) || /[\s<>"\\`{}|^\p{Cf}\p{Cc}]/u.test(body)) return -1
    this.b.open(this.id("autolink"))
    this.raw(i + 1, close)
    this.b.close(this.id("autolink"), i, close + 1)
    return close + 1
  }

  // --- names ------------------------------------------------------------------

  private colon(i: number, to: number): number {
    if (!this.atBoundary(i)) return -1
    const text = this.text
    let j = i + 1
    while (
      j < to &&
      (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 45 || text.charCodeAt(j) === 95)
    )
      j++
    if (j === i + 1) return -1
    if (text.charCodeAt(j) === 91 /* [ */) {
      const close = this.findBracketed(j, to, "[", "]")
      if (close < 0 || close <= j + 1) return -1
      this.b.open(this.id("extension_inline"))
      this.b.token(this.id("extension_marker_begin"), i, j + 1)
      this.b.open(this.id("args"))
      this.scan(j + 1, close, Context.InSpan)
      this.b.close(this.id("args"), j + 1, close)
      this.b.token(this.id("link_mark"), close, close + 1)
      this.b.close(this.id("extension_inline"), i, close + 1)
      return close + 1
    }
    if (text.charCodeAt(j) === 58 /* : */) {
      this.b.token(this.id("symbol"), i, j + 1)
      return j + 1
    }
    return -1
  }

  private mention(i: number, to: number): number {
    if (!this.atBoundary(i)) return -1
    const text = this.text
    let j = i + 1
    while (j < to && (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 95)) j++
    if (j === i + 1) return -1
    this.b.token(this.id("mention"), i, j)
    return j
  }

  private tag(i: number, to: number): number {
    if (!this.atBoundary(i)) return -1
    if (isDigit(this.text.charCodeAt(i + 1))) return -1 // `## 2` is a heading
    const text = this.text
    let j = i + 1
    while (j < to && (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 45)) j++
    if (j === i + 1) return -1
    this.b.token(this.id("tag"), i, j)
    return j
  }

  /** An italic span, or a merged bold-italic one when a star follows the slash. */
  private slash(i: number, to: number, ctx: Context): number {
    if (!this.openerOk(i, to)) return -1
    if (this.text.charCodeAt(i + 1) === 42 /* * */) {
      const content = i + 2
      const close = this.findDelimiter(content, to, "*/")
      if (close > content) {
        this.b.open(this.id("bold_italic"))
        this.b.token(this.id("bold_italic_begin"), i, content)
        this.scan(content, close, Context.Top)
        this.b.token(this.id("bold_italic_end"), close, close + 2)
        this.b.close(this.id("bold_italic"), i, close + 2)
        return close + 2
      }
      return -1
    }
    return this.symmetric(i, to, ctx, "/", "emphasis", "emphasis_begin", "emphasis_end")
  }

  private star(i: number, to: number, ctx: Context): number {
    if (!this.openerOk(i, to)) return -1
    return this.symmetric(i, to, ctx, "*", "strong", "strong_begin", "strong_end")
  }
}
