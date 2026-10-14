import type { Tree } from "@lezer/common"
import { citationKeyEnd } from "./citations.js"
import { InlineParser } from "./inline.js"
import { atColumn, columnOf, type ListMarker, type LogicalLine, makeLine } from "./lines.js"
import { indexOf, isAlnum, isDigit, isSpace, type Source } from "./source.js"
import type { Ids } from "./terms.js"
import type { TreeBuilder } from "./tree-builder.js"

export interface ReusedBlock {
  tree: Tree
  from: number
  to: number
}

/** What a line opens, before any tree is built. */
type Kind =
  | "heading"
  | "thematic_break"
  | "code_block"
  | "raw_block"
  | "comment_fence"
  | "comment_line"
  | "blockquote"
  | "div"
  | "list"
  | "definition_list"
  | "table"
  | "caption"
  | "block_attribute"
  | "link_ref"
  | "citation_def"
  | "footnote_def"
  | "continuation_marker"
  | "abbreviation_def"
  | "frontmatter"

const MAX_NESTING = 256

/**
 * Phases 1 and 2 of the grammar: the layout automaton (spec PART 0) and the
 * block elements (PART 2).
 *
 * The spec states the layout layer as a per-line automaton over an explicit
 * container stack, with column arithmetic and ownership rules deciding which
 * container each line belongs to. This is the same computation in
 * recursive-descent form: every container first reduces the lines it owns to
 * {@link LogicalLine}s with the prefix already stripped, then hands that list
 * to {@link blocksIn}, which classifies one line at a time. Stripping the
 * prefix up front is what makes quoting, list items and colon fences compose
 * without a shared stack.
 *
 * Where the spec is deliberately open — the authored block base of
 * CARVE-P0-004, the band of CARVE-P0-021 — we take the reading that keeps the
 * tree well formed for an editor: a recognised opener at or past a container's
 * content column opens a block, and anything below it folds into the enclosing
 * paragraph. At document level, where no container permits rebasing, markers
 * must sit in column 0 (CARVE-P2-001).
 *
 * This file owns classification and emission. What a line *is* — the re-basing
 * arithmetic, the two columns it tracks — lives in `lines.ts`, because getting
 * that arithmetic wrong is what turns a nested container into a stray sibling,
 * and it deserves to be readable without the rest of the block phase.
 */
export class BlockParser {
  private readonly text: string
  private readonly ids: Ids
  private readonly inline: InlineParser
  private depth = 0

  constructor(
    private readonly src: Source,
    private readonly b: TreeBuilder,
    private readonly features: ReadonlySet<string>,
    ids: Ids
  ) {
    this.text = src.text
    this.ids = ids
    this.inline = new InlineParser(src, b, ids, features)
  }

  private id(name: string): number {
    return this.ids[name]
  }

  // ---------------------------------------------------------------------------

  /** Parse or reuse one top-level block per step. Nested blocks stay atomic. */
  *parseDocument(reuse: (from: number) => ReusedBlock | null = () => null): Generator<number> {
    let count = this.src.lineCount
    if (count === 0 || (count === 1 && this.src.length === 0)) return
    let first = 0
    this.src.lookAhead = 0
    const initial = reuse(0)
    if (initial) {
      this.b.reuse(initial.tree, initial.from)
      first = this.src.lineAt(initial.to - 1) + 1
      yield initial.to
    } else if (this.kindAt(makeLine(this.src, 0, 0), 0) === "frontmatter") {
      first = this.frontmatter(0, count)
      const to = this.src.lineStarts[first] ?? this.src.length
      this.b.finishBlock(0, to, this.src.lookAhead)
      yield to
    }
    // A document ending in a newline has an empty line after it, and that line
    // holds nothing: no block can end there. Leaving it in the list lets a
    // container's extent run one character past the content it actually owns,
    // because a blank line's end is the end of the document.
    if (count > first + 1 && this.src.lineText(count - 1) === "") count--
    const items: LogicalLine[] = new Array(count - first)
    // Record the lines examined by container lookahead, including a line that
    // prevents a list/quote from continuing. That boundary must stay unchanged.
    const tracked = new Proxy(items, {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          const index = Number(key)
          if (index < target.length) {
            let item = target[index]
            if (!item) {
              item = makeLine(this.src, first + index, 0)
              target[index] = item
            }
            this.src.track(this.src.lineStarts[item.line + 1] ?? this.src.length + 1)
            return item
          }
        }
        return Reflect.get(target, key, receiver)
      },
      has: (target, key) => {
        // Array.slice/map must see lazy entries rather than sparse-array holes.
        return typeof key === "string" && /^\d+$/.test(key)
          ? Number(key) < target.length
          : Reflect.has(target, key)
      }
    })
    let i = 0
    while (i < items.length) {
      this.src.lookAhead = 0
      const it = tracked[i]
      if (it.blank) {
        i++
        continue
      }
      const cached = reuse(this.src.lineStarts[it.line])
      if (cached) {
        this.b.reuse(cached.tree, cached.from)
        i = this.src.lineAt(cached.to - 1) + 1 - first
        yield cached.to
        continue
      }
      const from = this.src.lineStarts[it.line]
      const kind = it.col > it.end ? null : this.kindAt(it, i + first)
      if (kind) {
        const next = this.block(tracked, i)
        i = next > i ? next : i + 1
      } else {
        let paraFrom = it.col,
          paraTo = it.end
        i++
        while (i < tracked.length) {
          const next = tracked[i]
          if (next.blank || (next.col <= next.end && this.kindAt(next, i + first))) break
          paraTo = next.end
          i++
        }
        this.b.open(this.id("paragraph"))
        this.inline.run(paraFrom, paraTo)
        this.b.close(this.id("paragraph"), paraFrom, paraTo)
      }
      const to = this.src.lineStarts[first + i] ?? this.src.length
      if (i >= items.length) this.src.track(this.src.length + 1)
      this.b.finishBlock(from, to, this.src.lookAhead)
      yield to
    }
    // A document that is nothing but whitespace produces no blocks, but its
    // tree still has to span it.
    if (this.b.empty) {
      this.b.token(this.id("content"), 0, this.src.length)
      this.b.finishBlock(0, this.src.length, this.src.length + 1)
    }
  }

  /**
   * Parse `items[from..]` as a sequence of blocks, folding runs of ordinary
   * lines into paragraphs.
   *
   * `prologue(upto, guard)` is called just before the loop reaches item
   * `upto`. `guard` is the earliest offset at which content is about to be
   * written — the pending paragraph's start, or this item's own column — and a
   * container may only emit a marker ending before it. A marker past the guard
   * would leave the builder before the block that precedes it, and Lezer
   * siblings may not run backwards.
   *
   * `continuations` enables the lone-`+` marker, which only means something
   * inside a container it can attach to.
   */
  private blocksIn(
    items: LogicalLine[],
    from = 0,
    prologue?: (upto: number, guard: number) => void,
    continuations = false
  ): void {
    // Extremely deep quotes or marker-line lists must still be editable.
    // Beyond the recursion budget, retain their contents as ordinary prose.
    const descend = this.depth++ < MAX_NESTING
    let i = from
    let paraFrom = -1
    let paraTo = -1

    const flush = () => {
      if (paraFrom < 0) return
      this.b.open(this.id("paragraph"))
      this.inline.run(paraFrom, paraTo)
      this.b.close(this.id("paragraph"), paraFrom, paraTo)
      paraFrom = -1
      paraTo = -1
    }

    while (i < items.length) {
      const it = items[i]
      if (prologue) prologue(i, paraFrom >= 0 ? paraFrom : it.col)
      if (it.blank) {
        flush()
        i++
        continue
      }
      // Classify before emitting: the pending paragraph must be flushed first,
      // or the postfix buffer would put the later block before the earlier one.
      const kind = !descend || it.col > it.end ? null : this.kindAt(it, i, continuations)
      if (kind) {
        flush()
        const next = this.block(items, i, continuations)
        // A handler that returns its own index has consumed nothing, and the
        // loop would spin on it — emitting the same block over and over until
        // the node buffer overflows. Losing one line's classification is a far
        // better outcome than hanging the editor, and the kind of bug that
        // causes this is a handler measuring from the wrong column.
        i = next > i ? next : i + 1
        continue
      }
      if (paraFrom < 0) paraFrom = it.col
      paraTo = it.end
      i++
    }
    flush()
    if (prologue) prologue(items.length, Infinity)
    this.depth--
  }

  /**
   * Parse the block starting at `items[i]`, returning the index just past it,
   * or `i` when no block opens here.
   */
  private block(items: LogicalLine[], i: number, continuations = false): number {
    const it = items[i]
    if (it.col > it.end) return i
    switch (this.kindAt(it, i, continuations)) {
      case "heading":
        this.heading(it)
        return i + 1
      case "thematic_break":
        this.b.token(this.id("thematic_break"), it.col, it.end)
        return i + 1
      case "caption":
        this.caption(it)
        return i + 1
      case "block_attribute":
        this.blockAttribute(it)
        return i + 1
      case "comment_line":
        this.b.open(this.id("comment_line"))
        this.scan(it.col, it.end)
        this.b.close(this.id("comment_line"), it.col, it.end)
        return i + 1
      case "comment_fence":
        return this.commentFence(items, i)
      case "code_block":
      case "raw_block":
        return this.fencedCode(items, i, this.isRawFence(it))
      case "blockquote":
        return this.blockQuote(items, i)
      case "continuation_marker":
        // The marker is punctuation; the block it attaches follows as the next
        // item, which the loop parses in this container.
        this.b.token(this.id("list_continuation_marker"), it.col, it.end)
        return i + 1
      case "div":
        return this.div(items, i)
      case "table":
        return this.table(items, i)
      case "link_ref":
        this.linkRefDef(it)
        return i + 1
      case "citation_def":
        this.citationDef(it)
        return i + 1
      case "abbreviation_def":
        this.abbreviationDef(it)
        return i + 1
      case "footnote_def":
        return this.footnoteDef(items, i)
      case "definition_list":
        return this.definitionList(items, i)
      case "list":
        return this.list(items, i)
      default:
        return i
    }
  }

  // --- classification ---------------------------------------------------------

  /**
   * What, if anything, opens at this line's content column. Kept free of tree
   * building and recursion so callers can ask "does this line start a block?"
   * while deciding where a container ends.
   */
  private kindAt(it: LogicalLine, index: number, continuations = false): Kind | null {
    const text = this.text
    const col = it.col
    const end = it.end
    if (col > end) return null
    // A line indented past a container's content column rebases its own block
    // (CARVE-P0-004) — but at document level no container permits that, so an
    // indented opener is ordinary text (CARVE-P2-001).
    if (it.baseCol === 0 && it.start - this.src.origin(it.line) > it.baseCol) return null
    const c = text.charCodeAt(col)

    if (c === 35 /* # */ && this.headingKind(it) !== 0) return "heading"
    if (c === 94 /* ^ */ && col + 1 < end && text.charCodeAt(col + 1) === 32) return "caption"
    if (c === 123 /* { */ && this.isAttributeLine(col, end)) return "block_attribute"
    if (c === 37 /* % */ && text.startsWith("%%", col)) {
      return text.startsWith("%%%", col) ? "comment_fence" : "comment_line"
    }
    if (c === 91 /* [ */) {
      if (this.features.has("citations") && this.citationLabelEnd(col, end) > 0)
        return "citation_def"
      if (text.charCodeAt(col + 1) === 94 && this.footnoteLabelEnd(col, end) > 0)
        return "footnote_def"
      if (this.linkRefLabelEnd(col, end) > 0) return "link_ref"
    }
    if (c === 42 /* * */ && this.abbreviationLabelEnd(col, end) > 0) return "abbreviation_def"
    if (c === 124 /* | */) return "table"
    if (c === 62 /* > */) return "blockquote"
    // A lone `+` attaches the next flush-left block to its container (PART 9
    // §17). It is punctuation, not prose, so it has to be claimed here rather
    // than folded into a paragraph.
    if (continuations && c === 43 /* + */ && this.isContinuationLine(it))
      return "continuation_marker"
    // Backticks and tildes both fence code; a tilde fence is never raw.
    if ((c === 96 /* ` */ || c === 126) /* ~ */ && this.runLength(col, c) >= 3) return "code_block"
    if (c === 58 /* : */) {
      const colons = this.runLength(col, 58)
      if (colons >= 3) return "div"
      if (colons === 2 && this.isTermLine(it)) return "definition_list"
    }
    if (
      index === 0 &&
      it.line === 0 &&
      it.baseCol === 0 &&
      c === 45 &&
      this.runLength(col, 45) >= 3 &&
      this.looksLikeFrontmatter(0)
    ) {
      return "frontmatter"
    }
    if (this.themeBreakKind(it) !== 0) return "thematic_break"
    if (this.listMarkerAt(it)) return "list"
    return null
  }

  /** Heading level, or 0 when this is not a heading. */
  /** An attribute block is a line of its own: the brace must close the line. */
  private isAttributeLine(col: number, end: number): boolean {
    const close = this.inline.attributeEnd(col, end)
    return close > 0 && this.src.restIsBlank(this.src.lineAt(close - 1), close)
  }

  /** A backtick or tilde fence whose info starts with `=` opens raw content. */
  private isRawFence(it: LogicalLine): boolean {
    const glyph = this.text.charCodeAt(it.col)
    if (glyph !== 96 && glyph !== 126) return false
    let from = it.col + this.runLength(it.col, glyph)
    while (from < it.end && isSpace(this.text.charCodeAt(from))) from++
    return this.text.charCodeAt(from) === 61 /* = */
  }

  private headingKind(it: LogicalLine): number {
    const col = it.col
    const end = it.end
    const n = this.runLength(col, 35)
    if (n < 1 || n > 6) return 0
    let i = col + n
    if (i >= end || !isSpace(this.text.charCodeAt(i))) return 0
    while (i < end && isSpace(this.text.charCodeAt(i))) i++
    return i < end ? n : 0 // hashes and separator alone open no heading
  }

  /**
   * Whether this line is a lone `+`: the continuation marker, not prose and not
   * a `+++` run. It attaches the following flush-left block to the container
   * it sits in (PART 9 §17).
   */
  private isContinuationLine(it: LogicalLine): boolean {
    if (this.text.charCodeAt(it.col) !== 43 /* + */) return false
    if (this.runLength(it.col, 43) !== 1) return false
    return this.src.restIsBlank(it.line, it.col + 1)
  }

  private themeBreakKind(it: LogicalLine): number {
    const c = this.text.charCodeAt(it.col)
    if (c !== 45 /* - */ && c !== 42 /* * */ && c !== 95 /* _ */) return 0
    const n = this.runLength(it.col, c)
    return n >= 3 && this.src.restIsBlank(this.src.lineAt(it.col), it.col + n) ? n : 0
  }

  private runLength(from: number, code: number): number {
    let n = 0
    while (this.text.charCodeAt(from + n) === code) n++
    return n
  }

  // --- headings and small blocks ----------------------------------------------

  private heading(it: LogicalLine): void {
    const level = this.headingKind(it)
    const markerEnd = it.col + level
    let content = markerEnd
    while (content < it.end && isSpace(this.text.charCodeAt(content))) content++
    this.b.open(this.id("heading"))
    this.b.token(this.id("marker"), it.col, markerEnd)
    this.inline.run(content, it.end)
    this.b.close(this.id("heading"), it.col, it.end)
  }

  private caption(it: LogicalLine): void {
    let content = it.col + 1
    while (content < it.end && this.text.charCodeAt(content) === 32) content++
    this.b.open(this.id("caption"))
    this.b.token(this.id("caption_marker"), it.col, content)
    this.b.open(this.id("caption_content"))
    this.inline.run(content, it.end)
    this.b.close(this.id("caption_content"), content, it.end)
    this.b.close(this.id("caption"), it.col, it.end)
  }

  private blockAttribute(it: LogicalLine): void {
    const close = this.inline.attributeEnd(it.col, it.end)
    this.inline.attribute(it.col, close, "block_attribute")
  }

  private linkRefLabelEnd(col: number, end: number): number {
    // Core link labels reserve the @-first namespace even without citations.
    if (this.text.charCodeAt(col + 1) === 64) return -1
    const close = indexOf(this.text, "]", col + 1, end)
    if (close <= col + 1 || close + 1 >= end) return -1
    return this.text.charCodeAt(close + 1) === 58 /* : */ ? close : -1
  }

  private footnoteLabelEnd(col: number, end: number): number {
    const close = indexOf(this.text, "]", col + 2, end)
    if (close <= col + 2 || close + 1 >= end) return -1
    return this.text.charCodeAt(close + 1) === 58 /* : */ ? close : -1
  }

  private abbreviationLabelEnd(col: number, end: number): number {
    if (this.text.charCodeAt(col + 1) !== 91 /* [ */) return -1
    const close = indexOf(this.text, "]", col + 2, end)
    if (close <= col + 2 || close + 1 >= end) return -1
    return this.text.charCodeAt(close + 1) === 58 /* : */ ? close : -1
  }

  // --- frontmatter -------------------------------------------------------------

  /**
   * A typed opener (`---yaml`) is frontmatter unconditionally. A bare `---`
   * takes the YAML shape test of CARVE-P2-030: the first non-blank, non-`#`
   * line inside must be a mapping key at column 0.
   */
  private looksLikeFrontmatter(index: number): boolean {
    const open = this.text.slice(this.src.origin(index), this.src.lineEnd(index))
    const typed = /^--- ?[A-Za-z0-9]+[ \t]*$/.test(open)
    if (!typed && !/^---[ \t]*$/.test(open)) return false
    let closeLine = -1
    for (let l = index + 1; l < this.src.lineCount; l++) {
      if (/^---[ \t]*$/.test(this.src.lineText(l))) {
        closeLine = l
        break
      }
    }
    if (closeLine < 0) return false
    if (typed) return true
    for (let l = index + 1; l < closeLine; l++) {
      const text = this.src.lineText(l)
      if (/^[ \t]*$/.test(text)) continue
      if (/^[ \t]*#/.test(text)) continue
      return /^([A-Za-z0-9_][^:\n]*|"[^"]*"|'[^']*'):(\s|$)/.test(text)
    }
    return false
  }

  private frontmatter(from: number, to: number): number {
    const text = this.text
    // A leading byte-order mark belongs to the encoding. Measuring the opener
    // from the line start would find no dashes at all, and emit a
    // `frontmatter_marker` covering nothing.
    const start = this.src.origin(from)
    const end = this.src.lineEnd(from)
    const openEnd = start + this.runLength(start, 45)
    const format = text.slice(openEnd, end).trim()
    let closeLine = -1
    for (let l = from + 1; l < to; l++) {
      if (/^---[ \t]*$/.test(this.src.lineText(l))) {
        closeLine = l
        break
      }
    }
    if (closeLine < 0) return from
    const contentStart = this.src.lineStarts[from + 1] ?? end
    const contentEnd = this.src.lineStarts[closeLine]
    const closeStart = contentEnd
    const closeEnd = this.src.lineEnd(closeLine)

    this.b.open(this.id("frontmatter"))
    // The opener line, the body, then the closing delimiter, each its own node.
    this.b.open(this.id("content"))
    this.b.token(this.id("frontmatter_marker"), start, openEnd)
    if (format) {
      const languageStart = this.src.skipSpaces(openEnd, end)
      this.b.token(this.id("language"), languageStart, languageStart + format.length)
    }
    this.b.close(this.id("content"), start, end)
    if (contentEnd > contentStart)
      this.b.token(this.id("frontmatter_content"), contentStart, contentEnd)
    this.b.token(this.id("frontmatter_marker"), closeStart, closeEnd)
    this.b.close(this.id("frontmatter"), start, closeEnd)
    return closeLine + 1
  }

  // --- fences -----------------------------------------------------------------

  /**
   * The item index just past a fence closer, or -1. Code/raw closers can be
   * longer than their opener and must use its column. Comment closers match
   * the exact width, at any column, with the rest of their line ignored.
   *
   * The search runs over `items`, not the whole document: a fence closes with
   * its container, never past it (CARVE-P0-014). A line whose content column
   * falls below the fence's own column is searched past but never matched —
   * it belongs to an enclosing container, and treating its fence as the closer
   * would let a fence swallow the rest of the file.
   */
  private fenceClose(
    items: LogicalLine[],
    from: number,
    openCol: number,
    glyph: number,
    length: number
  ): number {
    for (let i = from; i < items.length; i++) {
      const line = items[i]
      if (line.blank || (glyph !== 37 && columnOf(line) !== openCol)) continue
      const n = this.runLength(line.col, glyph)
      if (
        glyph === 37 ? n === length : n >= length && this.src.restIsBlank(line.line, line.col + n)
      )
        return i + 1
    }
    return -1
  }

  /**
   * The item index just past the last line that belongs to a container whose
   * content column is `openCol`.
   *
   * An unclosed fence ends there rather than at the end of the array: a quote's
   * line list can still hold lines below the quote's own column, and those
   * belong to whatever encloses the quote, not to the fence.
   */
  private fenceLimit(items: LogicalLine[], from: number, openCol: number): number {
    let limit = from
    for (let i = from; i < items.length; i++) {
      if (!items[i].blank && columnOf(items[i]) >= openCol) limit = i + 1
    }
    return limit
  }

  private fencedCode(items: LogicalLine[], i: number, raw: boolean): number {
    const it = items[i]
    const glyph = this.text.charCodeAt(it.col)
    const length = this.runLength(it.col, glyph)
    const close = this.fenceClose(items, i + 1, columnOf(it), glyph, length)
    const limit = close >= 0 ? close : this.fenceLimit(items, i + 1, columnOf(it))
    const wrap = raw ? "raw_block" : "code_block"
    const begin = raw ? "raw_block_marker_begin" : "code_block_marker_begin"
    const endNode = raw ? "raw_block_marker_end" : "code_block_marker_end"

    this.b.open(this.id(wrap))
    this.b.token(this.id(begin), it.col, it.col + length)
    const info = this.text.slice(it.col + length, it.end)
    if (info.trim()) {
      this.b.open(this.id(raw ? "raw_block_info" : "code_block_header"))
      if (raw) {
        // `=name` names the output format; a bare `=` names none. A node with
        // no characters in it is not a node, so the token is simply not
        // emitted rather than emitted with an empty range.
        const name = /^\s*=\s*([a-z][a-z0-9+.-]*)/i.exec(info)
        if (name) {
          const from = it.col + length + name[0].length - name[1].length
          this.b.token(this.id("language"), from, from + name[1].length)
        }
      } else {
        this.codeHeader(it.col + length, it.end)
      }
      this.b.close(this.id(raw ? "raw_block_info" : "code_block_header"), it.col + length, it.end)
    }
    this.fenceBody(
      items,
      i + 1,
      close >= 0 ? close - 1 : limit,
      raw ? "content" : "code",
      close >= 0
    )
    if (close >= 0) {
      // The closing delimiter starts at the container's content column, not at
      // the line start: on a quoted fence the `> ` belongs to the quote marker,
      // and two sibling tokens may not overlap.
      const closer = items[close - 1]
      this.b.token(this.id(endNode), closer.col, closer.col + this.runLength(closer.col, glyph))
    }
    const closerEnd = close >= 0 ? items[close - 1].end : items[limit - 1].end
    this.b.close(this.id(wrap), it.col, closerEnd)
    return close >= 0 ? close : limit
  }

  /**
   * Emit a fenced block's payload.
   *
   * Each line is emitted from its own content column, so a block inside a quote
   * or a list item does not carry the container's prefix into the code — which
   * matters both for highlighting and for handing the body to a nested parser.
   */
  private fenceBody(
    items: LogicalLine[],
    from: number,
    to: number,
    node: string,
    closed: boolean
  ): void {
    if (from >= to) return
    // `col` skips indentation used to classify blocks. Opaque payloads keep
    // that indentation and remove only the container's prefix (`baseCol`).
    const contentStart = (line: LogicalLine) => Math.min(line.end, line.lineStart + line.baseCol)
    const last = items[to - 1]
    // A closed fence owns every payload line's terminator, including a sole
    // blank line. An unclosed fence must stay within its enclosing container.
    // Claim the opening line break for code so a cursor at the next line's
    // start is inside the mounted language even with CodeMirror's left bias.
    const start = node === "code" ? items[from - 1].end : contentStart(items[from]),
      end = closed ? (this.src.lineStarts[last.line + 1] ?? last.end) : last.end
    if (start >= end) return
    this.b.open(this.id(node))
    for (let i = from; i < to; i++) {
      const line = items[i]
      const content = contentStart(line)
      if (content < line.end) this.b.token(this.id("content"), content, line.end)
    }
    this.b.close(this.id(node), start, end)
  }

  /** The `language "Header" [Label]` remainder of a fence opener line. */
  private codeHeader(from: number, to: number): void {
    let i = from
    while (i < to && isSpace(this.text.charCodeAt(i))) i++
    let langEnd = i
    while (
      langEnd < to &&
      (isAlnum(this.text.charCodeAt(langEnd)) || /[#+.-]/.test(this.text[langEnd]))
    )
      langEnd++
    if (langEnd > i) this.b.token(this.id("language"), i, langEnd)
    i = langEnd
    while (i < to) {
      while (i < to && this.text.charCodeAt(i) === 32) i++
      if (i >= to) break
      const c = this.text.charCodeAt(i)
      if (c === 34 /* " */) {
        const close = indexOf(this.text, '"', i + 1, to)
        if (close < 0 || close >= to) break
        this.b.token(this.id("link_mark"), i, i + 1)
        this.b.open(this.id("div_title"))
        this.scan(i + 1, close)
        this.b.close(this.id("div_title"), i + 1, close)
        this.b.token(this.id("link_mark"), close, close + 1)
        i = close + 1
      } else if (c === 91 /* [ */) {
        const close = indexOf(this.text, "]", i + 1, to)
        if (close < 0 || close >= to) break
        this.b.token(this.id("code_block_label"), i, close + 1)
        i = close + 1
      } else break
    }
  }

  private commentFence(items: LogicalLine[], i: number): number {
    const it = items[i]
    const length = this.runLength(it.col, 37)
    const close = this.fenceClose(items, i + 1, columnOf(it), 37, length)
    const limit = close >= 0 ? close : this.fenceLimit(items, i + 1, columnOf(it))
    this.b.open(this.id("fenced_comment_block"))
    this.b.token(this.id("comment_fence_marker_begin"), it.col, it.col + length)
    const info = this.text.slice(it.col + length, it.end)
    if (info.trim()) this.b.token(this.id("comment_fence_info"), it.col + length, it.end)
    this.fenceBody(items, i + 1, close >= 0 ? close - 1 : limit, "content", close >= 0)
    if (close >= 0) {
      const closer = items[close - 1]
      this.b.token(this.id("comment_fence_marker_end"), closer.col, closer.col + length)
    }
    const closerEnd = close >= 0 ? items[close - 1].end : items[limit - 1].end
    this.b.close(this.id("fenced_comment_block"), it.col, closerEnd)
    return close >= 0 ? close : limit
  }

  // --- quotes -----------------------------------------------------------------

  /**
   * A quote owns every following line carrying the marker, plus lazy prose
   * that reaches no other container (CARVE-P0-015). A line that opens a block
   * at the quote's content column stays inside it (CARVE-P0-021).
   */
  private blockQuote(items: LogicalLine[], i: number): number {
    const text = this.text
    const start = items[i].col
    let last = i
    const children: LogicalLine[] = []
    const markers: [number, number][] = []

    // Every line's marker sits at that line's content column, which for a
    // nested quote is the column just past the enclosing quote's marker.
    const markerOf = (it: LogicalLine): number => {
      let end = it.col + 1
      if (end < it.end && isSpace(text.charCodeAt(end))) end++
      return end
    }

    const openerEnd = markerOf(items[i])
    markers.push([items[i].col, openerEnd])
    children.push(atColumn(items[i], openerEnd - items[i].lineStart))

    for (let l = i + 1; l < items.length; l++) {
      const it = items[l]
      if (it.blank) break // a blank closes the quote and everything in it
      // `+` on its own line attaches the next flush-left block to this quote
      // (PART 9 §17). The marker is quote punctuation; the block it introduces
      // becomes a child of the quote.
      if (text.charCodeAt(it.col) === 43 /* + */ && this.isContinuationLine(it)) {
        const next = items[l + 1]
        if (!next || next.blank) break
        children.push(it)
        children.push(atColumn(next, Math.max(next.baseCol, next.indent)))
        last = l + 1
        l++
        continue
      }
      if (text.charCodeAt(it.col) !== 62 /* > */) {
        // Lazy prose folds in only while it opens no block of its own.
        if (this.kindAt({ ...it, col: it.start }, l) != null) break
        children.push(atColumn(it, Math.max(it.baseCol, it.indent)))
        last = l
        continue
      }
      const markerEnd = markerOf(it)
      markers.push([it.col, markerEnd])
      children.push(atColumn(it, markerEnd - it.lineStart))
      last = l
    }

    this.b.open(this.id("block_quote"))
    let emitted = 0
    this.blocksIn(
      children,
      0,
      (upto, guard) => {
        while (emitted <= upto && emitted < markers.length) {
          const [from, to] = markers[emitted]
          // Past the guard: the block that precedes this marker has not been
          // written yet, so emitting now would put the two out of order. The
          // final call passes an unbounded guard, so nothing is dropped.
          if (to > guard) return
          emitted++
          // Already claimed by a block: a `>` inside a fence is part of the code,
          // and a `>` opening a paragraph's second line sits inside the
          // paragraph. Only the quote's own opener is guaranteed to survive.
          if (to <= this.b.coveredTo) continue
          this.b.token(this.id("block_quote_marker"), from, to)
        }
      },
      true
    )
    this.b.close(this.id("block_quote"), start, children[children.length - 1].end)
    return last + 1
  }

  // --- colon containers --------------------------------------------------------

  /** Match the innermost colon fence, skipping complete opaque child blocks. */
  private divClose(items: LogicalLine[], from: number): number {
    const widths = [this.runLength(items[from].col, 58)]
    for (let i = from + 1; i < items.length; i++) {
      const line = items[i]
      if (line.blank) continue
      const glyph = this.text.charCodeAt(line.col)
      if (glyph !== 96 && glyph !== 126 && glyph !== 37 && glyph !== 58) continue
      const width = this.runLength(line.col, glyph)
      if ((glyph === 96 || glyph === 126 || glyph === 37) && width >= 3) {
        const after = this.fenceClose(items, i + 1, columnOf(line), glyph, width)
        // An unclosed fence cannot hide this container's structural closer.
        if (after >= 0) i = after - 1
        continue
      }
      if (glyph !== 58 || width < 3) continue
      if (
        width === widths[widths.length - 1] &&
        this.src.restIsBlank(line.line, line.col + width)
      ) {
        widths.pop()
        if (!widths.length) return i
      } else {
        widths.push(width)
      }
    }
    return -1
  }

  private div(items: LogicalLine[], i: number): number {
    const text = this.text
    const it = items[i]
    const colons = this.runLength(it.col, 58)
    let j = it.col + colons
    while (j < it.end && text.charCodeAt(j) === 32) j++
    const typeFrom = j
    while (
      j < it.end &&
      (isAlnum(text.charCodeAt(j)) || text.charCodeAt(j) === 45 || text.charCodeAt(j) === 95)
    )
      j++
    const type = text.slice(typeFrom, j)

    const close = this.divClose(items, i)
    const last = close < 0 ? items.length - 1 : close - 1
    this.b.open(this.id("div"))
    this.b.token(this.id("div_marker_begin"), it.col, it.col + colons)
    if (type === "figure") {
      // A bare `::: figure` is a composite figure, not an admonition.
      this.b.token(this.id("figure_group_marker"), typeFrom, j)
    } else if (type) {
      this.b.token(this.id("admonition_type"), typeFrom, j)
    } else if (j < it.end) {
      // The reserved sigils name their own container kind.
      const sigil = text.charCodeAt(j)
      const sigilNode =
        sigil === 124 /* | */
          ? "line_block_marker"
          : sigil === 92 /* \ */
            ? "local_hard_break_marker"
            : sigil === 62 /* > */
              ? "block_quote_fence_marker"
              : null
      if (sigilNode) this.b.token(this.id(sigilNode), j, j + 1)
    }
    let afterType = j
    while (afterType < it.end && text.charCodeAt(afterType) === 32) afterType++
    if (text.charCodeAt(afterType) === 34 /* " */) {
      const titleEnd = indexOf(text, '"', afterType + 1, it.end)
      if (titleEnd > 0 && titleEnd < it.end) {
        this.b.token(this.id("link_mark"), afterType, afterType + 1)
        this.b.open(this.id("div_title"))
        this.scan(afterType + 1, titleEnd)
        this.b.close(this.id("div_title"), afterType + 1, titleEnd)
        this.b.token(this.id("link_mark"), titleEnd, titleEnd + 1)
      }
    } else if (text.charCodeAt(afterType) === 91 /* [ */) {
      const labelEnd = indexOf(text, "]", afterType + 1, it.end)
      if (labelEnd > 0 && labelEnd < it.end)
        this.b.token(this.id("code_block_label"), afterType, labelEnd + 1)
    }
    const children = items.slice(i + 1, close >= 0 ? close : last + 1)
    this.blocksIn(children.map(c => (c.blank ? c : atColumn(c, Math.max(c.baseCol, c.indent)))))
    let closeEnd = it.end
    for (const child of children) if (!child.blank && child.end > closeEnd) closeEnd = child.end
    if (close >= 0) this.b.token(this.id("div_marker_end"), items[close].col, items[close].end)
    this.b.close(this.id("div"), it.col, close >= 0 ? items[close].end : closeEnd)
    return close >= 0 ? close + 1 : last + 1
  }

  // --- tables ------------------------------------------------------------------

  private table(items: LogicalLine[], i: number): number {
    const text = this.text
    const start = items[i].col
    let last = i
    this.b.open(this.id("table"))
    for (let l = i; l < items.length; l++) {
      const it = items[l]
      // A container decides where a line's content begins. `it.start` is the
      // first non-space on the *physical* line, which is the enclosing
      // container's own marker once the line is nested inside it.
      const c = text.charCodeAt(it.col)
      if (l > i && c !== 124 /* | */ && c !== 43 /* + */) break
      if (it.blank) break
      const header = c === 124 && this.cellMarkers(it.col + 1, it.end).header
      // `continuation_row = '+', table_cell, ...`: the row starts at the plus
      // rather than a pipe, and it never begins a table.
      const continuation = !header && c === 43
      const node = header
        ? "table_header"
        : continuation
          ? "table_continuation_row"
          : this.isSeparatorLine(it)
            ? "table_separator"
            : "table_row"
      this.b.open(this.id(node))
      this.tableCells(it, continuation)
      this.b.close(this.id(node), it.col, it.end)
      last = l
    }
    // A `^ ` line directly below belongs to the table, unlike a caption after
    // any other block, which stays a sibling.
    const captionLine = last + 1
    if (captionLine < items.length) {
      const cap = items[captionLine]
      if (text.charCodeAt(cap.col) === 94 /* ^ */ && isSpace(text.charCodeAt(cap.col + 1))) {
        let contentFrom = cap.col + 1
        while (contentFrom < cap.end && text.charCodeAt(contentFrom) === 32) contentFrom++
        this.b.open(this.id("table_caption"))
        this.b.token(this.id("caption_marker"), cap.col, contentFrom)
        this.inline.run(contentFrom, cap.end)
        this.b.close(this.id("table_caption"), cap.col, cap.end)
        last = captionLine
      }
    }
    this.b.close(this.id("table"), start, items[last].end)
    return last + 1
  }

  private isSeparatorLine(it: LogicalLine): boolean {
    const text = this.text
    let i = it.col
    let saw = false
    while (i < it.end) {
      const c = text.charCodeAt(i)
      if (c === 124 /* | */ || c === 32) {
        i++
        continue
      }
      if (c === 61 /* = */ || c === 45 /* - */) {
        saw = true
        i += this.runLength(i, c)
        continue
      }
      return false
    }
    return saw
  }

  /**
   * Split one row into cells. `|=` heads a cell, an alignment run is glued to
   * the pipe and ended by a space, an attribute block is glued to the marker
   * run that precedes it, and a cell holding only `^` or `<` merges with the
   * one above or to the left.
   */
  private cellMarkers(from: number, end: number) {
    const text = this.text
    let i = from
    const header = text.charCodeAt(i) === 61
    if (header) i++
    const alignFrom = i
    const horizontal = text.charCodeAt(i)
    if (horizontal === 60 || horizontal === 62 || horizontal === 126 || horizontal === 63) {
      i++
      const vertical = text.charCodeAt(i)
      if (vertical === 94 || vertical === 126 || vertical === 118) i++
      else if (horizontal === 63) i = alignFrom
    }
    const alignTo = i
    const attrFrom = i
    const attrTo = text.charCodeAt(i) === 123 ? this.inline.attributeEnd(i, end) : -1
    if (attrTo > i) i = attrTo
    // Every authored marker run ends in an ASCII space. An invalid or
    // unpadded run is ordinary cell content, including its leading glyphs.
    if (i === from || i >= end || text.charCodeAt(i) !== 32) {
      return {
        header: false,
        alignFrom: from,
        alignTo: from,
        attrFrom: from,
        attrTo: -1,
        bodyFrom: from
      }
    }
    return { header, alignFrom, alignTo, attrFrom, attrTo, bodyFrom: i }
  }

  private tableCells(it: LogicalLine, continuation = false): void {
    const text = this.text
    let i = it.col
    const end = it.end
    // The first continuation cell uses `+` in place of its opening pipe.
    while (
      i < end &&
      (text.charCodeAt(i) === 124 /* | */ ||
        (continuation && i === it.col && text.charCodeAt(i) === 43))
    ) {
      const cellStart = i
      i++
      if (i >= end) break // the row's trailing pipe opens no extra cell
      const markers = this.cellMarkers(i, end)
      const cellEnd = this.inline.cellEnd(markers.bodyFrom, end)
      this.b.open(this.id("table_cell"))
      if (markers.alignTo > markers.alignFrom) {
        this.b.open(this.id("table_cell_alignment"))
        this.scan(markers.alignFrom, markers.alignTo)
        this.b.close(this.id("table_cell_alignment"), markers.alignFrom, markers.alignTo)
      }
      if (markers.attrTo > markers.attrFrom)
        this.inline.attribute(markers.attrFrom, markers.attrTo, "table_cell_attributes")
      let bodyFrom = markers.bodyFrom
      let bodyTo = cellEnd
      // The space that terminates the marker run is padding, not content.
      while (bodyFrom < bodyTo && text.charCodeAt(bodyFrom) === 32) bodyFrom++
      while (bodyTo > bodyFrom && text.charCodeAt(bodyTo - 1) === 32) bodyTo--
      // A cell holding only `^` or `<` merges with the one above or to the left.
      if (markers.attrTo < 0 && bodyTo - bodyFrom === 1) {
        const only = text.charCodeAt(bodyFrom)
        if (only === 94 /* ^ */ || only === 60 /* < */) bodyTo = bodyFrom
      }
      if (bodyTo > bodyFrom) this.inline.run(bodyFrom, bodyTo)
      this.b.close(this.id("table_cell"), cellStart, cellEnd)
      i = cellEnd
    }
  }

  // --- definitions -------------------------------------------------------------

  private citationLabelEnd(col: number, end: number): number {
    if (this.text.charCodeAt(col + 1) !== 64) return -1
    const close = citationKeyEnd(this.text, col + 2, end)
    return close > col + 2 && close + 1 < end && this.text.startsWith("]:", close) ? close : -1
  }

  /** A bibliography entry contains inlines on its own source line. */
  private citationDef(it: LogicalLine): void {
    const close = this.citationLabelEnd(it.col, it.end)
    this.b.open(this.id("citation_definition"))
    this.b.token(this.id("link_mark"), it.col, it.col + 2)
    this.b.token(this.id("citation_label"), it.col + 2, close)
    this.b.token(this.id("link_mark"), close, close + 2)
    let from = this.src.skipSpaces(close + 2, it.end)
    const attributes = this.inline.attribute(from, it.end, "inline_attribute")
    if (attributes > 0) from = this.src.skipSpaces(attributes, it.end)
    if (from < it.end) {
      this.b.open(this.id("citation_entry"))
      this.inline.run(from, it.end)
      this.b.close(this.id("citation_entry"), from, it.end)
    }
    this.b.close(this.id("citation_definition"), it.col, it.end)
  }

  private linkRefDef(it: LogicalLine): number {
    const close = this.linkRefLabelEnd(it.col, it.end)
    let destFrom = close + 2
    while (destFrom < it.end && isSpace(this.text.charCodeAt(destFrom))) destFrom++
    this.b.open(this.id("link_reference_definition"))
    this.b.open(this.id("link_label"))
    this.scan(it.col + 1, close)
    this.b.close(this.id("link_label"), it.col + 1, close)
    if (destFrom < it.end) {
      this.b.open(this.id("link_destination"))
      this.scan(destFrom, it.end)
      this.b.close(this.id("link_destination"), destFrom, it.end)
    }
    this.b.close(this.id("link_reference_definition"), it.col, it.end)
    return -1
  }

  private abbreviationDef(it: LogicalLine): number {
    const close = this.abbreviationLabelEnd(it.col, it.end)
    this.b.open(this.id("abbreviation_definition"))
    this.b.token(this.id("abbreviation_marker"), it.col, it.col + 2)
    this.scan(it.col + 2, close)
    if (it.end > close + 2) this.scan(close + 2, it.end)
    this.b.close(this.id("abbreviation_definition"), it.col, it.end)
    return -1
  }

  /**
   * `[^label]: body` — the body is indented by exactly two columns (PART 0),
   * and its extent includes blanks between its own blocks.
   */
  private footnoteDef(items: LogicalLine[], i: number): number {
    const it = items[i]
    const close = this.footnoteLabelEnd(it.col, it.end)
    // The body starts after `[^label]: ` and its continuation lines are
    // indented by exactly two columns (PART 0).
    let firstCol = close + 2
    while (firstCol < it.end && this.text.charCodeAt(firstCol) === 32) firstCol++
    let last = i
    for (let l = i + 1; l < items.length; l++) {
      const next = items[l]
      if (next.blank) {
        let probe = l + 1
        while (probe < items.length && items[probe].blank) probe++
        if (probe < items.length && this.logicalIndent(items[probe]) >= it.baseCol + 2) {
          last = probe
          l = probe
          continue
        }
        break
      }
      if (this.logicalIndent(next) < it.baseCol + 2) break
      last = l
    }
    const children = items
      .slice(i, last + 1)
      .map((c, n) =>
        n === 0 ? atColumn(c, firstCol - c.lineStart) : c.blank ? c : atColumn(c, c.baseCol + 2)
      )
    this.b.open(this.id("footnote"))
    // `[^`, the label, `]:` — three disjoint siblings, matching upstream's
    // shape. One node spanning all three would swallow the label.
    this.b.token(this.id("footnote_marker_begin"), it.col, it.col + 2)
    this.b.open(this.id("reference_label"))
    this.scan(it.col + 2, close)
    this.b.close(this.id("reference_label"), it.col + 2, close)
    this.b.token(this.id("footnote_marker_end"), close, close + 2)
    const bodyFrom = Math.min(children[0].col, it.end)
    const bodyTo = items[last].end
    if (bodyTo > bodyFrom) {
      this.b.open(this.id("footnote_content"))
      this.blocksIn(children)
      this.b.close(this.id("footnote_content"), bodyFrom, bodyTo)
    }
    this.b.close(this.id("footnote"), it.col, items[last].end)
    return last + 1
  }

  // --- lists -------------------------------------------------------------------

  /** The list marker at this line's content column, or null. */
  private listMarkerAt(it: LogicalLine): ListMarker | null {
    const text = this.text
    const col = it.col
    const end = it.end
    if (col >= end) return null
    const c = text.charCodeAt(col)

    if (c === 45 /* - */ || c === 42 /* * */) {
      if (!this.spaceAfterMarker(col + 1, end)) return null
      return {
        node: c === 45 ? "list_marker_dash" : "list_marker_star",
        contentAt: col + 1,
        kind: "bullet"
      }
    }
    if (c === 46 /* . */) {
      // `. auto-numbered` is Carve's native, indent-stable list form.
      if (!this.spaceAfterMarker(col + 1, end)) return null
      return { node: null, contentAt: col + 1, kind: "auto" }
    }
    if (isDigit(c)) {
      let i = col
      while (i < end && isDigit(text.charCodeAt(i))) i++
      if (i - col > 9) return null
      const closer = text.charCodeAt(i)
      if (closer === 46 /* . */ && this.spaceAfterMarker(i + 1, end)) {
        return { node: "list_marker_decimal_period", contentAt: i + 1, kind: "decimal" }
      }
      if (closer === 41 /* ) */) {
        if (this.spaceAfterMarker(i + 1, end)) {
          return { node: "list_marker_decimal_paren", contentAt: i + 1, kind: "decimal" }
        }
        if (text.charCodeAt(i + 1) === 41 && this.spaceAfterMarker(i + 2, end)) {
          return { node: "list_marker_decimal_parens", contentAt: i + 2, kind: "decimal" }
        }
      }
      return null
    }
    if (isAlnum(c)) {
      // Portable dialected forms: `a.`, `A)`, `i.`, `IV:`.
      let i = col
      while (i < end && isAlnum(text.charCodeAt(i))) i++
      const run = text.slice(col, i)
      if (!/^[A-Za-z]+$/.test(run)) return null
      const upper = /^[A-Z]+$/.test(run)
      const roman = /^[ivxlcdm]+$/i.test(run)
      const kind = roman
        ? upper
          ? "upper_roman"
          : "lower_roman"
        : upper
          ? "upper_alpha"
          : "lower_alpha"
      const closer = text.charCodeAt(i)
      const sep =
        closer === 46 ? "period" : closer === 41 ? "paren" : closer === 58 /* : */ ? "parens" : ""
      if (sep && this.spaceAfterMarker(i + 1, end)) {
        return { node: `list_marker_${kind}_${sep}`, contentAt: i + 1, kind: "alpha" }
      }
    }
    return null
  }

  private spaceAfterMarker(from: number, end: number): boolean {
    if (from >= end) return false
    const c = this.text.charCodeAt(from)
    return c === 91 /* [ */ || isSpace(c)
  }

  private list(items: LogicalLine[], i: number): number {
    const start = items[i].col
    const first = this.listMarkerAt(items[i])
    if (!first) return i
    const column = columnOf(items[i])
    this.b.open(this.id("list"))
    let last = this.listItem(items, i, first, column)
    while (last + 1 < items.length) {
      let l = last + 1
      if (items[l].blank) {
        // A blank line ends an item, but the list continues when what follows
        // is another item of the same list.
        let probe = l
        while (probe < items.length && items[probe].blank) probe++
        if (probe >= items.length) break
        const marker = this.listMarkerAt(items[probe])
        if (!marker || columnOf(items[probe]) !== column || marker.node !== first.node) break
        l = probe
      }
      const marker = this.listMarkerAt(items[l])
      if (!marker || columnOf(items[l]) !== column || marker.node !== first.node) break
      last = this.listItem(items, l, marker, column)
    }
    this.b.close(this.id("list"), start, items[last].end)
    return last + 1
  }

  /** How far an item reaches: indented continuation, plus lazy prose. */
  private itemExtent(
    items: LogicalLine[],
    from: number,
    contentCol: number,
    listCol: number
  ): number {
    let last = from
    const contentColumn = contentCol - items[from].lineStart
    for (let l = from + 1; l < items.length; l++) {
      const it = items[l]
      if (it.blank) {
        let probe = l
        while (probe < items.length && items[probe].blank) probe++
        if (probe < items.length && this.logicalIndent(items[probe]) >= contentColumn) {
          last = probe
          l = probe
          continue
        }
        break
      }
      const indent = this.logicalIndent(it)
      if (indent >= contentColumn) {
        last = l
        continue
      }
      if (this.listMarkerAt(it)) break // a sibling item, or another list
      // A lone `+` at the item's marker column attaches the block below it to
      // this item, flush-left and unmarked (PART 9 §17). This is the list half
      // of what a block quote does with the same marker.
      if (indent === listCol && this.isContinuationLine(it)) {
        const end = this.continuationExtent(items, l + 1)
        if (end <= l) break
        last = end
        l = end
        continue
      }
      if (indent === listCol) break // any other block at the list's column
      // Lazy prose: ordinary text below the item's column folds in.
      if (this.kindAt({ ...it, col: it.start }, l) != null) break
      last = l
    }
    return last
  }

  /**
   * The last line of the block a continuation marker attaches.
   *
   * The attached block sits at the container's own column and carries no
   * marker, so it cannot be recognised by the ordinary `indent >= content`
   * rule. Only the container kinds that reach their own closer need measuring
   * here; anything else is prose, which runs to the next line that opens a
   * block of its own.
   */
  private continuationExtent(items: LogicalLine[], from: number): number {
    if (from >= items.length) return from - 1
    const it = items[from]
    if (it.blank) return from - 1
    const col = it.col
    const column = columnOf(it)
    const text = this.text
    const c = text.charCodeAt(col)
    let last = from

    if ((c === 96 /* ` */ || c === 126) /* ~ */ && this.runLength(col, c) >= 3) {
      const after = this.fenceClose(items, from + 1, column, c, this.runLength(col, c))
      if (after >= 0) return after - 1
      last = items.length - 1
    } else if (c === 58 /* : */ && this.runLength(col, 58) >= 3) {
      const close = this.divClose(items, from)
      if (close >= 0) return close
      for (let l = from + 1; l < items.length; l++) {
        // A blank line closes every container, and the last line of a document
        // that ends in a newline is blank for no reason of its own. Absorbing
        // either would make the block reach past the container holding it.
        if (items[l].blank) break
        last = l
      }
    } else if (c === 37 /* % */ && text.startsWith("%%%", col)) {
      const after = this.fenceClose(items, from + 1, column, c, this.runLength(col, c))
      if (after >= 0) return after - 1
      for (let l = from + 1; l < items.length; l++) {
        if (items[l].blank) break
        last = l
      }
    } else {
      // Prose, or any block this measurement does not follow: it runs until a
      // line that opens a block of its own.
      for (let l = from + 1; l < items.length; l++) {
        const line = items[l]
        if (line.blank) break
        if (columnOf(line) === column && this.kindAt(line, l) != null) break
        last = l
      }
    }
    return last
  }

  private listItem(
    items: LogicalLine[],
    index: number,
    marker: ListMarker,
    listCol: number
  ): number {
    const text = this.text
    const it = items[index]
    const contentCol = marker.contentAt
    const last = this.itemExtent(items, index, contentCol, listCol)

    // The content column is past the marker itself; a task checkbox, when
    // present, is content and not marker width (CARVE-P0-008).
    let afterMarker = contentCol
    while (afterMarker < it.end && isSpace(text.charCodeAt(afterMarker))) afterMarker++
    let taskEnd = -1
    if (text.charCodeAt(afterMarker) === 91 /* [ */) {
      const inner = text.charCodeAt(afterMarker + 1)
      if (
        (inner === 32 || inner === 120 || inner === 88) &&
        text.charCodeAt(afterMarker + 2) === 93 &&
        afterMarker + 3 < it.end &&
        isSpace(text.charCodeAt(afterMarker + 3))
      ) {
        taskEnd = afterMarker + 3
      }
    }
    let bodyCol = taskEnd > 0 ? taskEnd : afterMarker
    while (bodyCol < it.end && isSpace(text.charCodeAt(bodyCol))) bodyCol++

    this.b.open(this.id("list_item"))
    if (marker.node) this.b.token(this.id(marker.node), it.col, contentCol)
    if (taskEnd > 0) {
      const inner = text.charCodeAt(afterMarker + 1)
      this.b.open(this.id("list_marker_task"))
      this.b.token(
        this.id(inner === 120 || inner === 88 ? "checked" : "unchecked"),
        afterMarker + 1,
        taskEnd - 1
      )
      this.b.close(this.id("list_marker_task"), afterMarker, taskEnd)
    }
    const indent = bodyCol - it.lineStart
    // The item's own line is re-read from its content column so its marker is
    // not mistaken for a nested list. A continuation line indented less than
    // the content column starts at its own first non-space instead, which is
    // what makes under-indented prose read as lazy continuation.
    const children = items.slice(index, last + 1).map((c, n) => {
      if (c.blank) return c
      if (n === 0) return atColumn(c, bodyCol - c.lineStart)
      const leading = this.logicalIndent(c)
      return atColumn(c, Math.max(c.baseCol, leading >= indent ? indent : leading))
    })
    this.b.open(this.id("list_item_content"))
    this.blocksIn(children, 0, undefined, true)
    this.b.close(this.id("list_item_content"), bodyCol, items[last].end)
    this.b.close(this.id("list_item"), it.col, items[last].end)
    return last
  }

  /** `:: term` opens an entry; `: definition` supplies its description. */
  private isTermLine(it: LogicalLine): boolean {
    const text = this.text
    let i = it.col + 2
    while (i < it.end && text.charCodeAt(i) === 32) i++
    return i < it.end && text.charCodeAt(i) !== 58 /* : */
  }

  /**
   * `:: term` opens an entry and `: definition` supplies its description; both
   * live inside one `list_item`, matching the upstream tree.
   */
  private definitionList(items: LogicalLine[], i: number): number {
    const start = items[i].col
    let last = i
    let sawTerm = false
    let sawDefinition = false
    let itemStart = start
    this.b.open(this.id("definition_list"))
    while (last < items.length) {
      const it = items[last]
      if (it.blank) break
      const colons = this.runLength(it.col, 58)
      if (colons === 2 && this.isTermLine(it)) {
        if (sawTerm && sawDefinition) {
          this.b.close(this.id("list_item"), itemStart, items[last - 1].end)
          sawTerm = false
        }
        if (!sawTerm) {
          this.b.open(this.id("list_item"))
          itemStart = it.col
          sawTerm = true
        }
        sawDefinition = false
        this.b.token(this.id("list_marker_definition"), it.col, it.col + 2)
        let termFrom = it.col + 2
        while (termFrom < it.end && this.text.charCodeAt(termFrom) === 32) termFrom++
        this.b.open(this.id("term"))
        this.inline.run(termFrom, it.end)
        this.b.close(this.id("term"), termFrom, it.end)
        last++
        continue
      }
      if (colons === 1 || colons === 2) {
        if (!sawTerm) break
        sawDefinition = true
        let contentFrom = it.col + colons
        while (contentFrom < it.end && this.text.charCodeAt(contentFrom) === 58 /* : */)
          contentFrom++
        while (contentFrom < it.end && this.text.charCodeAt(contentFrom) === 32) contentFrom++
        this.b.token(this.id("list_marker_description"), it.col, contentFrom)
        this.b.open(this.id("definition"))
        this.inline.run(contentFrom, it.end)
        this.b.close(this.id("definition"), contentFrom, it.end)
        last++
        continue
      }
      break
    }
    const end = items[Math.max(i, last - 1)].end
    if (sawTerm) this.b.close(this.id("list_item"), itemStart, end)
    this.b.close(this.id("definition_list"), start, end)
    return last
  }

  // --- helpers -----------------------------------------------------------------

  /** Leading columns after stripping the enclosing container's prefix. */
  private logicalIndent(it: LogicalLine): number {
    return this.src.skipSpaces(Math.min(it.end, it.lineStart + it.baseCol), it.end) - it.lineStart
  }

  /** Emit a run of text as a `content` leaf. */
  private scan(from: number, to: number): void {
    if (to > from) this.b.token(this.id("content"), from, to)
  }
}
