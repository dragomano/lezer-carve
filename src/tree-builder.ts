import { type NodeSet, Tree } from "@lezer/common"
import { blockInfo, parserOwner } from "./incremental.js"

/**
 * Accumulates nodes in the postfix order `Tree.build` expects and hands back a
 * finished [`Tree`](https://lezer.codemirror.net/docs/ref/#common.Tree).
 *
 * The buffer holds four numbers per node — type id, start offset, end offset,
 * and the number of buffer slots the node's whole subtree occupies. Reading
 * backwards, a node's size tells `Tree.build` how far back to look for its
 * children, so a correct size is what makes the tree come out nested: it
 * counts the node itself as well as every descendant.
 */
export class TreeBuilder {
  private readonly buffer: number[] = []
  /** Buffer index at which the children of each open node begin. */
  private readonly open_: number[] = []
  private readonly children: Tree[] = []
  private readonly positions: number[] = []
  private covered = 0

  constructor(
    private readonly nodeSet: NodeSet,
    private readonly owner: object,
    private readonly mapPosition: (pos: number, side: -1 | 1) => number = pos => pos,
    private readonly reusable = true
  ) {}

  /** Record where the next node's children will start. */
  open(_type: number): void {
    this.open_.push(this.buffer.length)
  }

  /** True while nothing has been written. */
  get empty(): boolean {
    return this.buffer.length === 0 && this.children.length === 0
  }

  /**
   * The end offset of the most recently written node, or 0 when there is none.
   *
   * Containers use this to leave out their own punctuation when it has already
   * been claimed by a block: a `>` inside a fenced block is part of the code,
   * not a quote marker, and two sibling nodes may not overlap.
   */
  get coveredTo(): number {
    const buffer = this.buffer
    return buffer.length ? buffer[buffer.length - 2] : this.covered
  }

  /** Append a childless node spanning `from`..`to`. */
  token(type: number, from: number, to: number): void {
    this.buffer.push(type, from, to, 4)
  }

  /** Close the node opened by the matching `open`, spanning `from`..`to`. */
  close(type: number, from: number, to: number): void {
    const childrenStart = this.open_.pop()
    if (childrenStart == null) throw new RangeError("close() without a matching open()")
    // An empty marker line can leave a container with nothing to hold. Lezer
    // does not need such a node, and a zero-length one only confuses folding.
    if (to <= from && this.buffer.length === childrenStart) return
    this.buffer.push(type, from, to, this.buffer.length - childrenStart + 4)
  }

  /** Materialize one document block, leaving its descendants compact. */
  finishBlock(from: number, to: number, lookAhead: number): void {
    if (this.open_.length) throw new RangeError("Unclosed node at a block boundary")
    if (!this.buffer.length) return
    this.covered = this.buffer[this.buffer.length - 2]
    for (let i = 0; i < this.buffer.length; i += 4) {
      this.buffer[i + 1] = this.mapPosition(this.buffer[i + 1], 1)
      this.buffer[i + 2] = this.mapPosition(this.buffer[i + 2], -1)
    }
    const start = this.mapPosition(from, 1),
      end = this.mapPosition(to, -1)
    const last = this.buffer.length - 4
    if (this.buffer[last + 3] === this.buffer.length) {
      // Build the block directly instead of packing it inside a temporary
      // document and then extracting it from that document's TreeBuffer.
      const type = this.buffer[last],
        pos = this.buffer[last + 1],
        nodeEnd = this.buffer[last + 2]
      this.buffer.length = last
      let node = Tree.build({
        buffer: this.buffer,
        nodeSet: this.nodeSet,
        topID: type,
        start: pos,
        length: nodeEnd - pos
      })
      if (this.reusable) {
        node = new Tree(node.type, node.children, node.positions, node.length, [
          [
            blockInfo,
            {
              owner: this.owner,
              from: start - pos,
              to: end - pos,
              lookAhead: this.mapPosition(lookAhead, -1) - pos,
              atStart: from === 0
            }
          ]
        ])
      }
      this.children.push(node)
      this.positions.push(pos)
      this.buffer.length = 0
      return
    }
    const tree = Tree.build({
      buffer: this.buffer,
      nodeSet: this.nodeSet,
      topID: 0,
      start,
      length: end - start
    })
    const only = tree.topNode.firstChild && !tree.topNode.firstChild.nextSibling
    for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
      let node = child.toTree(),
        pos = start + child.from
      if (only && this.reusable) {
        node = new Tree(
          node.type,
          node.children,
          node.positions,
          node.length,
          node.propValues.concat([
            [
              blockInfo,
              {
                owner: this.owner,
                from: start - pos,
                to: end - pos,
                lookAhead: this.mapPosition(lookAhead, -1) - pos,
                atStart: from === 0
              }
            ]
          ])
        )
      }
      this.children.push(node)
      this.positions.push(pos)
    }
    this.buffer.length = 0
  }

  reuse(tree: Tree, from: number): void {
    this.children.push(tree)
    this.positions.push(from)
    this.covered = from + tree.length
  }

  /** The root spans the selected input, including whitespace between blocks. */
  build(length: number): Tree {
    if (this.open_.length || this.buffer.length) throw new RangeError("Unfinished block")
    return new Tree(
      this.nodeSet.types[0],
      this.children,
      this.positions,
      length,
      this.reusable ? [[parserOwner, this.owner]] : undefined
    )
  }
}
