import type { SyntaxNode, Tree } from "@lezer/common"
import { CarveParser, NODE_IDS, NODE_SPEC } from "lezer-carve"

const parser = new CarveParser()

/** Parse `text` and return the tree. */
export function parse(text: string): Tree {
  return parser.parse(text)
}

/**
 * A snapshot of a syntax node, with its ancestors.
 *
 * These are copies rather than `SyntaxNode`s because a node reached through a
 * `TreeCursor` is a view over shared storage that the next cursor move
 * overwrites — and `node.parent` follows that view, not the node it came from.
 * The walker below builds the parent links itself, from cursor positions.
 */
export interface NodeRef {
  name: string
  from: number
  to: number
  parent: NodeRef | null
}

/**
 * Visit every node in document order with its ancestors attached. Return
 * `false` from `visit` to stop early.
 */
function walk(tree: Tree, visit: (node: NodeRef) => boolean | undefined): void {
  const cursor = tree.cursor()
  const stack: NodeRef[] = []
  for (;;) {
    const current = cursor.node
    const ref: NodeRef = {
      name: current.name,
      from: current.from,
      to: current.to,
      parent: stack.length ? stack[stack.length - 1] : null
    }
    if (visit(ref) === false) return
    if (cursor.firstChild()) {
      stack.push(ref)
      continue
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return
      stack.pop()
    }
  }
}

/** Every node name in the tree, in document order. */
export function nodeNames(tree: Tree): string[] {
  const names: string[] = []
  walk(tree, node => void names.push(node.name))
  return names
}

/** Every node with the given name, in document order. */
export function findNodes(tree: Tree, name: string): NodeRef[] {
  const found: NodeRef[] = []
  walk(tree, node => {
    if (node.name === name) found.push(node)
  })
  return found
}

/** The first node with the given name, or null. */
export function findNode(tree: Tree, name: string): NodeRef | null {
  const matches = findNodes(tree, name)
  return matches.length ? matches[0] : null
}
/** The node names enclosing the node at `pos`, outermost first. */
export function nodePathAt(tree: Tree, pos: number): string[] {
  const path: string[] = []
  for (let node: SyntaxNode | null = tree.resolveInner(pos, 1); node; node = node.parent) {
    path.unshift(node.name)
  }
  return path
}

/**
 * Check the structural invariants every produced tree must satisfy: the tree
 * spans the document, nodes are non-empty, and no child escapes its parent.
 */
export function checkInvariants(text: string, tree = parse(text)): void {
  if (tree.length !== text.length) {
    throw new Error(`Tree length ${tree.length} != document length ${text.length}`)
  }
  const top = tree.topNode
  if (top.type.id !== 0) throw new Error(`Top node is ${top.name}, expected document`)
  if (top.from !== 0 || top.to !== text.length) {
    throw new Error(`Document spans [${top.from},${top.to}], expected [0,${text.length}]`)
  }
  walk(tree, node => {
    if (node.from > node.to) throw new Error(`${node.name} has from > to`)
    // The root of an empty document has no content, which is not a defect.
    if (node.name === "document") return
    if (node.from === node.to) throw new Error(`${node.name} is empty at ${node.from}`)
    const parent = node.parent!
    if (node.from < parent.from || node.to > parent.to) {
      throw new Error(
        `${node.name} [${node.from},${node.to}] escapes its parent ${parent.name} ` +
          `[${parent.from},${parent.to}]`
      )
    }
  })
  checkNoOverlaps(tree)
}

/**
 * Children of the same parent must be ordered and disjoint.
 *
 * Containment alone does not catch a token that starts before its previous
 * sibling ends — a quoted fence's closing delimiter reaching back over the
 * quote marker, for instance — and Lezer will happily keep the result.
 */
function checkNoOverlaps(tree: Tree): void {
  const cursor = tree.cursor()
  // `lastChildEnd[d]` is where the most recent child of the node at depth `d`
  // ended; it resets to -1 on the way down into each new node.
  const lastChildEnd = [-1]
  let depth = 0
  for (;;) {
    const node = cursor.node
    const previous = lastChildEnd[depth]
    if (node.from < previous) {
      throw new Error(
        `${node.name} [${node.from},${node.to}] starts before its previous sibling ends at ${previous}`
      )
    }
    lastChildEnd[depth] = node.to
    if (cursor.firstChild()) {
      depth++
      lastChildEnd[depth] = -1
      continue
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return
      depth--
    }
  }
}

/** Assert the tree contains no error nodes. */
export function checkNoErrors(tree: Tree): void {
  tree.cursor().iterate(node => {
    if (node.type.isError || node.name === "!ERROR!") {
      throw new Error(`Unexpected error node ${node.name} at ${node.from}`)
    }
  })
}

/** A compact indented rendering of the tree, for readable assertions. */
export function dumpTree(text: string, tree = parse(text)): string {
  const out: string[] = []
  walk(tree, node => {
    let depth = 0
    for (let parent = node.parent; parent; parent = parent.parent) depth++
    let snippet = JSON.stringify(text.slice(node.from, node.to).replace(/\n/g, "\\n"))
    if (snippet.length > 40) snippet = `${snippet.slice(0, 37)}…${snippet[snippet.length - 1]}`
    out.push(`${"  ".repeat(depth)}${node.name} [${node.from},${node.to}] ${snippet}`)
  })
  return out.join("\n")
}

export { NODE_IDS, NODE_SPEC, parser }
