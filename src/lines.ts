import type { Source } from "./source.js"

/**
 * The line model.
 *
 * Carve's PART 0 is a per-line automaton over an explicit container stack: each
 * physical line is read once per container it belongs to, rebased to that
 * container's content column, and classified from there. A *logical line* is
 * one line seen from one container, and this file is the whole of that
 * vocabulary — what a line is, and how re-basing it works. The block phase in
 * `blocks.ts` owns the classification and the tree; nothing here builds a node.
 *
 * Two columns are in play and confusing them is the easiest way to get this
 * wrong, so they are named for what they measure:
 *
 *   - `baseCol` is how far the content column is from the line's own start.
 *     A container nested inside another re-bases a child to
 *     `max(baseCol, indent)`, never to `baseCol + indent`: `indent` is already
 *     measured from the margin, so adding the two double-counts every level
 *     and shifts content a column per level of nesting.
 *   - `indent` is the line's own leading whitespace, from the margin.
 *
 * `col > end` means the line holds nothing usable at or past the container's
 * content column — an over-indented continuation, not a block.
 */
export interface LogicalLine {
  /** Index of the physical line, for lookups that work in line numbers. */
  line: number
  /** Offset at which line columns begin, past a leading encoding BOM. */
  lineStart: number
  /** Offset of the first non-whitespace character. */
  start: number
  /** Offset just past the last character, excluding the newline. */
  end: number
  /** The container's content column, measured from this line's start. */
  baseCol: number
  /** Offset at which this line's content starts. */
  col: number
  /** Leading whitespace columns. */
  indent: number
  blank: boolean
}

/** A list marker found at a line's content column. */
export interface ListMarker {
  /** Node name for the marker, or `null` when upstream has no dedicated node. */
  node: string | null
  /** Offset of the first character after the marker. */
  contentAt: number
  /** Which list this marker belongs to: bullet, decimal or auto-numbered. */
  kind: "bullet" | "decimal" | "alpha" | "auto"
}

/** Build a logical line whose content column is `contentCol` columns in. */
export function makeLine(src: Source, line: number, contentCol: number): LogicalLine {
  const lineStart = src.origin(line)
  const end = src.lineEnd(line)
  const indent = src.indentAt(line)
  const start = src.skipSpaces(lineStart, end)
  let col = lineStart + contentCol
  if (col < start) col = start
  return { line, lineStart, start, end, baseCol: contentCol, col, indent, blank: start >= end }
}

/**
 * Re-read a line `column` columns in, where `column` is measured from the
 * line's own start — the same arithmetic `indent` uses.
 *
 * Emptiness is re-read rather than carried over. A bare `>` line is blank from
 * just past its marker and has to split the enclosing quote's paragraphs, but
 * the original line has a character on it — the quote's own marker — and so
 * does not read as blank.
 */
export function atColumn(it: LogicalLine, column: number): LogicalLine {
  const col = Math.max(it.start, it.lineStart + column)
  return { ...it, baseCol: column, col, blank: it.blank || col >= it.end }
}

/** The line's content column, measured from the line's own start. */
export function columnOf(it: LogicalLine): number {
  return it.col - it.lineStart
}
