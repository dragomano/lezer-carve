import {
  type Input,
  type NodePropSource,
  type NodeSet,
  Parser,
  type ParseWrapper,
  type PartialParse,
  Tree,
  type TreeFragment
} from "@lezer/common"
import type { ReusedBlock } from "./blocks.js"
import { BlockParser } from "./blocks.js"
import { blockInfo, parserOwner } from "./incremental.js"
import { Source } from "./source.js"
import { carveNodeSet, makeIds } from "./terms.js"
import { TreeBuilder } from "./tree-builder.js"

export { Source } from "./source.js"
export * from "./terms.js"

/** Reconfiguration options for {@link CarveParser.configure}. */
export interface CarveConfig {
  /**
   * Parse wrappers, most usefully `parseMixed` from `@lezer/common` to parse
   * fenced code with the language it names.
   */
  wrap?: ParseWrapper | readonly ParseWrapper[]
  /** Node properties to add to the node set. */
  props?: readonly NodePropSource[]
  /**
   * Optional syntax to recognise. Core syntax needs no entry here; `raw`
   * enables `{=html}` inline passthrough and is enabled by default.
   * `citations` enables citation groups and bibliography definitions (off by
   * default). Supplying this array replaces the default extension set.
   */
  extensions?: readonly string[]
}

/**
 * The default feature set: core syntax plus raw inline, which Carve enables by
 * default in its JavaScript and Rust renderers.
 */
const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set(["raw"])

/**
 * A parser for the Carve markup language.
 *
 * Unlike a generated LR parser this is an ordinary recursive-descent parser
 * that assembles the tree by hand. That is not a stylistic choice: the spec's
 * PART 0 is a per-line automaton with column arithmetic, a container stack and
 * lookahead guards for fence closers, none of which an LR table can express —
 * the upstream tree-sitter grammar needs a hand-written external scanner to
 * get there. Writing the parser directly also lets block and inline phases
 * share one line model instead of approximating it.
 *
 * Parsing advances one document block at a time. Unchanged blocks are reused
 * from TreeFragments when their full input and boundary lookahead are intact.
 * Disjoint input ranges are parsed without reuse, preserving their offsets.
 */
export class CarveParser extends Parser {
  /** Name-to-id map for this parser's node set. */
  readonly nodeTypes: { [name: string]: number }

  constructor(
    readonly nodeSet: NodeSet = carveNodeSet,
    readonly extensions: ReadonlySet<string> = DEFAULT_EXTENSIONS,
    private readonly wrappers: readonly ParseWrapper[] = []
  ) {
    super()
    this.nodeTypes = makeIds(nodeSet)
  }

  /** The root node type every parse produces. */
  get topType() {
    return this.nodeSet.types[0]
  }

  createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly { from: number; to: number }[]
  ): PartialParse {
    let parse: PartialParse = new IncrementalParse(this, input, fragments, ranges)
    for (const wrapper of this.wrappers) parse = wrapper(parse, input, fragments, ranges)
    return parse
  }

  /** Reconfigure the parser. Returns `this` when nothing changes. */
  configure(spec: CarveConfig = {}): CarveParser {
    const props = spec.props || []
    const wraps = spec.wrap ? (Array.isArray(spec.wrap) ? spec.wrap : [spec.wrap]) : []
    const extensions = spec.extensions ? new Set(spec.extensions) : this.extensions
    if (!props.length && !wraps.length && extensions === this.extensions) return this
    return new CarveParser(
      props.length ? this.nodeSet.extend(...props) : this.nodeSet,
      extensions,
      this.wrappers.concat(wraps)
    )
  }
}

/** A lazy parse that yields between complete document blocks. */
class IncrementalParse implements PartialParse {
  stoppedAt: number | null = null
  private readonly from: number
  private readonly end: number
  private pos: number
  private tree: Tree | null = null
  private builder: TreeBuilder | null = null
  private blocks: Generator<number> | null = null
  private source: ReturnType<typeof readRanges> | null = null

  constructor(
    private readonly parser: CarveParser,
    private readonly input: Input,
    private readonly fragments: readonly TreeFragment[],
    private readonly ranges: readonly { from: number; to: number }[]
  ) {
    this.from = ranges.length ? ranges[0].from : 0
    this.end = ranges.length ? ranges[ranges.length - 1].to : this.from
    this.pos = this.from
  }

  get parsedPos(): number {
    return this.pos
  }

  advance(): Tree | null {
    if (this.tree) return this.tree
    if (!this.blocks) {
      // A completely unchanged range needs no input materialisation at all.
      if (this.ranges.length === 1 && this.stoppedAt == null) {
        for (const fragment of this.fragments) {
          if (
            fragment.tree.prop(parserOwner) === this.parser &&
            !fragment.openStart &&
            !fragment.openEnd &&
            fragment.from <= this.from &&
            fragment.to >= this.end &&
            fragment.offset === -this.from &&
            fragment.tree.length === this.end - this.from
          ) {
            this.pos = this.end
            this.tree = fragment.tree
            return this.tree
          }
        }
      }
      this.source = readRanges(this.input, this.ranges)
      this.builder = new TreeBuilder(
        this.parser.nodeSet,
        this.parser,
        this.source.mapPosition,
        this.ranges.length === 1
      )
      const src = new Source(this.source.text)
      const reuse = this.reusableBlocks()
      this.blocks = new BlockParser(
        src,
        this.builder,
        this.parser.extensions,
        this.parser.nodeTypes
      ).parseDocument(from => reuse.get(from) || null)
    }
    const { blocks, builder, source } = this
    if (!blocks || !builder || !source) throw new Error("Uninitialized parse")
    if (this.stoppedAt == null || this.pos < this.stoppedAt) {
      const step = blocks.next()
      if (!step.done) {
        this.pos =
          this.from + (source.mapPosition ? source.mapPosition(step.value, -1) : step.value)
        return null
      }
      this.pos = this.end
    }
    this.tree = builder.build(this.pos - this.from)
    return this.tree
  }

  stopAt(pos: number): void {
    if (this.stoppedAt != null && pos > this.stoppedAt)
      throw new RangeError("Cannot stop at a position after the current stop")
    this.stoppedAt = pos
  }

  private reusableBlocks(): Map<number, ReusedBlock> {
    const result = new Map<number, ReusedBlock>()
    if (this.ranges.length !== 1) return result
    for (const fragment of this.fragments) {
      const root = fragment.tree
      if (root.prop(parserOwner) !== this.parser) continue
      // A document with many edits has many fragments of the same tree.
      // Search only each fragment's children instead of rescanning the root.
      let low = 0,
        high = root.positions.length,
        start = fragment.from + fragment.offset
      while (low < high) {
        const mid = (low + high) >> 1
        if (root.positions[mid] < start) low = mid + 1
        else high = mid
      }
      for (let i = Math.max(0, low - 1); i < root.children.length; i++) {
        if (root.positions[i] > fragment.to + fragment.offset) break
        const tree = root.children[i]
        if (!(tree instanceof Tree)) continue
        const info = tree.prop(blockInfo)
        if (!info || info.owner !== this.parser) continue
        const pos = root.positions[i] - fragment.offset
        const from = pos + info.from,
          to = pos + info.to,
          lookAhead = pos + info.lookAhead
        const eof = lookAhead === this.end + 1 && fragment.to >= this.end && !fragment.openEnd
        if (
          from < this.from ||
          to > this.end ||
          fragment.from > from ||
          fragment.to < to ||
          (fragment.to < lookAhead && !eof) ||
          (fragment.openEnd && lookAhead >= fragment.to) ||
          info.atStart !== (from === this.from)
        )
          continue
        result.set(from - this.from, { tree, from: pos - this.from, to: to - this.from })
      }
    }
    return result
  }
}

/**
 * Concatenate only the selected ranges, then map the resulting nodes back to
 * offsets relative to the first range. At a join, starts belong to the next
 * range and ends to the previous one, so tokens do not claim an excluded gap.
 *
 * The block phase needs unbounded lookahead — fence closers and container
 * extents both scan forward past the current line — so the text is
 * materialised once per parse rather than pulled in chunks.
 */
function readRanges(input: Input, ranges: readonly { from: number; to: number }[]) {
  const from = ranges.length ? ranges[0].from : 0
  const end = ranges.length ? ranges[ranges.length - 1].to : from
  const starts: number[] = []
  let offset = 0
  const text = ranges
    .map(range => {
      starts.push(offset)
      offset += range.to - range.from
      return input.read(range.from, range.to)
    })
    .join("")
  const mapPosition =
    ranges.length <= 1
      ? undefined
      : (pos: number, side: -1 | 1): number => {
          let low = 0,
            high = ranges.length - 1
          while (low < high) {
            const mid = (low + high + 1) >> 1
            if (starts[mid] < pos || (starts[mid] === pos && side > 0)) low = mid
            else high = mid - 1
          }
          return ranges[low].from - from + pos - starts[low]
        }
  return { text, length: end - from, end, mapPosition }
}

/** The parser instance used when none is supplied. */
export const parser: CarveParser = new CarveParser()
