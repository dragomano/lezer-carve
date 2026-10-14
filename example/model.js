import {TreeFragment} from "@lezer/common"

/** Half-open offsets are UTF-16 positions, just like the Lezer tree. */
export function changedRange(before, after) {
  let from = 0
  while (from < before.length && from < after.length && before[from] === after[from]) from++
  let toA = before.length
  let toB = after.length
  while (toA > from && toB > from && before[toA - 1] === after[toB - 1]) {
    toA--
    toB--
  }
  return {fromA: from, toA, fromB: from, toB}
}

export function treeSnapshot(tree) {
  const nodes = []
  tree.cursor().iterate(node => nodes.push([node.name, node.from, node.to]))
  return nodes
}

export function compareEdit(parser, before, after, previous = parser.parse(before)) {
  const change = changedRange(before, after)
  // A zero gap keeps short intact blocks available in this deliberately small demo.
  const fragments = before === after
    ? TreeFragment.addTree(previous)
    : TreeFragment.applyChanges(TreeFragment.addTree(previous), [change], 0)
  const tree = parser.parse(after, fragments)
  const full = parser.parse(after)
  const oldChildren = new Set(previous.children)
  const blocks = tree.children.map((child, index) => ({
    name: child.type.name,
    from: tree.positions[index],
    to: tree.positions[index] + child.length,
    reused: oldChildren.has(child)
  }))
  return {
    tree,
    blocks,
    change,
    reused: blocks.filter(block => block.reused).length,
    matchesFullParse: JSON.stringify(treeSnapshot(tree)) === JSON.stringify(treeSnapshot(full))
  }
}

export function nodeCategory(name) {
  if (name === "document") return "root"
  if (name === "marker" || name === "link_mark" || /marker|_delimiter|_(begin|end)$/.test(name)) return "marker"
  if (/^(heading|paragraph|list|list_item|block_quote|div|admonition|table|table_row|table_cell|code_block|raw_block|frontmatter|fenced_comment_block|citation_definition|footnote_definition)$/.test(name)) return "block"
  return "inline"
}

/** Read the real tree; no synthetic grammar nodes are added to the diagram. */
export function readTree(tree) {
  const all = []
  function visit(node, parent = null, depth = 0) {
    const item = {
      id: all.length,
      name: node.name,
      from: node.from,
      to: node.to,
      category: nodeCategory(node.name),
      depth,
      parent,
      children: []
    }
    all.push(item)
    for (let child = node.firstChild; child; child = child.nextSibling) {
      item.children.push(visit(child, item.id, depth + 1))
    }
    return item
  }
  const root = visit(tree.topNode)
  return {root, all}
}

/** Lay out a visible subtree from left to right, centering parents on their children. */
export function diagramLayout(root, {markers = false, collapsed = new Set(), limit = 220} = {}) {
  const nodes = []
  const edges = []
  let leaf = 0
  let truncated = false
  function place(node, depth = 0) {
    if (nodes.length >= limit) {
      truncated = true
      return null
    }
    const point = {...node, x: 24 + depth * 218, y: 0}
    nodes.push(point)
    const children = collapsed.has(node.id) ? [] : node.children.filter(child => markers || child.category !== "marker")
    const placed = children.map(child => place(child, depth + 1)).filter(Boolean)
    point.y = placed.length ? (placed[0].y + placed[placed.length - 1].y) / 2 : 24 + leaf++ * 64
    for (const child of placed) edges.push({from: point, to: child})
    point.folded = collapsed.has(node.id) && node.children.length > 0
    return point
  }
  place(root)
  return {
    nodes,
    edges,
    truncated,
    width: Math.max(360, ...nodes.map(node => node.x + 194)),
    height: Math.max(260, ...nodes.map(node => node.y + 72))
  }
}
