import {parser} from "lezer-carve"
import {compareEdit, diagramLayout, readTree, treeSnapshot} from "./model.js"
import {incrementalSource, samples} from "./samples.js"
import "./style.css"

const $ = id => document.getElementById(id)
const svgNS = "http://www.w3.org/2000/svg"
const source = $("source")
const svg = $("syntax-tree")
const viewport = $("tree-viewport")
const collapsed = new Set()
let activeParser = parser.configure({extensions: ["raw", "citations"]})
let tree
let data
let selected = 0
let layout
let zoom = 1
let job
let stepCalls = 0
let stepFinished = false
let debounce
let sourcePending = false
let editApplied = true

const stages = [
  ["Source", "On the first parsing step, the input is read and its line starts are indexed. These positions let the parser reason about columns and look ahead to block boundaries."],
  ["BlockParser", "Lines are classified into headings, paragraphs, lists, quotes and fences. Containers adjust the content columns of their lines and recursively parse the blocks they own."],
  ["InlineParser", "Within each text-bearing block, a left-to-right scan recognises spans such as strong text, emphasis and links. Code, raw payloads and comments keep their own syntax boundaries."],
  ["TreeBuilder", "Node types and source ranges are assembled into a Lezer Tree. Each top-level block becomes a subtree that later parses may reuse. The tree describes syntax; it does not render a document."]
]

const descriptions = {
  document: "The root spans the source and contains the document's top-level blocks.",
  heading: "A block with a heading marker and inline content. Its level comes from the marker's length.",
  paragraph: "A run of text that ends at a blank line or the opening of another block.",
  content: "The text-bearing part of a block. Inline syntax is nested within this range.",
  strong: "A bold span delimited by asterisks. Show punctuation to inspect its opening and closing tokens.",
  emphasis: "An italic span delimited by slashes. Show punctuation to inspect its delimiters.",
  bold_italic: "A span that combines bold and italic formatting.",
  block_quote: "A container that owns quoted lines and their nested blocks.",
  list: "A list container. Each child item owns its content and any nested blocks.",
  list_item: "One list item, including its marker and content.",
  list_item_content: "The content owned by a list item after its prefix is accounted for.",
  div: "A colon-fenced container. Its type, title and body have separate syntax nodes.",
  code_block: "A code fence with an opaque payload. No nested JavaScript parser is attached in this example.",
  code: "The code payload. Carve markup inside it is not parsed as inline spans.",
  raw_block: "A raw fence. Its body is retained without parsing Carve inline markup.",
  fenced_comment_block: "A comment fence whose payload is opaque to inline parsing.",
  citation_group: "A group of citation keys, optional prefixes and locators. It does not resolve or number sources.",
  citation_label: "A bibliography key. Its range excludes the @ marker.",
  citation_definition: "A single-line bibliography definition with a key, optional metadata and an entry.",
  citation_entry: "The bibliography entry's inline content, including any formatting.",
  inline_attribute: "Structured metadata attached to an element or bibliography definition.",
  inline_link: "An inline link. The label and destination have their own child nodes.",
  link_text: "The displayed label of a link.",
  link_destination: "The link's destination range.",
  inline_link_destination: "The destination inside an inline link.",
  verbatim: "An inline code span whose content is opaque to regular inline markup."
}

function makeSvg(tag, attributes = {}, content) {
  const element = document.createElementNS(svgNS, tag)
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value)
  if (content != null) element.textContent = content
  return element
}

function setStatus(message, failed = false) {
  const dot = document.createElement("span")
  dot.className = "status-dot"
  if (failed) dot.style.background = "#a56443"
  $("parse-status").replaceChildren(dot, document.createTextNode(message))
}

function syncSourceScroll() {
  $("source-overlay").style.transform = `translate(${-source.scrollLeft}px, ${-source.scrollTop}px)`
  $("line-numbers").scrollTop = source.scrollTop
}

function renderSourceRange() {
  const node = data.all[selected]
  const overlay = $("source-overlay")
  overlay.replaceChildren(document.createTextNode(source.value.slice(0, node.from)))
  const mark = document.createElement("mark")
  mark.textContent = source.value.slice(node.from, node.to)
  overlay.append(mark, document.createTextNode(source.value.slice(node.to) + "\n"))
  syncSourceScroll()
}

function updateInspector() {
  const node = data.all[selected]
  $("selected-name").textContent = node.name
  $("selected-category").textContent = node.category === "marker" ? "punctuation" : node.category
  $("selected-category").dataset.kind = node.category
  $("selected-description").textContent = descriptions[node.name] || (node.category === "marker"
    ? "A punctuation token that marks a syntax boundary. Its range covers the authored marker."
    : "A syntax node emitted by the parser. Its children and range describe the part of the source it owns.")
  $("selected-range").textContent = `[${node.from}, ${node.to})`
  $("selected-text").textContent = source.value.slice(node.from, node.to) || "(empty range)"
  const length = source.value.length || 1
  $("range-highlight").style.left = `${node.from / length * 100}%`
  $("range-highlight").style.width = `${(node.to - node.from) / length * 100}%`
  $("toggle-branch").disabled = node.children.length === 0
  $("toggle-branch").textContent = collapsed.has(selected) ? "Expand this branch" : "Collapse this branch"
  renderSourceRange()
}

function updateZoom() {
  svg.setAttribute("width", layout.width * zoom)
  svg.setAttribute("height", layout.height * zoom)
  $("zoom-value").textContent = `${Math.round(zoom * 100)}%`
  $("zoom-out").disabled = zoom <= .45
  $("zoom-in").disabled = zoom >= 1.5
}

function fitTree() {
  zoom = Math.max(.45, Math.min(1, (viewport.clientWidth - 16) / layout.width, (viewport.clientHeight - 16) / layout.height))
  updateZoom()
  viewport.scrollTo(0, 0)
}

function renderTree() {
  layout = diagramLayout(data.root, {markers: $("markers").checked, collapsed})
  svg.replaceChildren()
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`)
  const ancestors = new Set()
  for (let id = selected; id != null; id = data.all[id].parent) ancestors.add(id)
  for (const edge of layout.edges) {
    const x1 = edge.from.x + 170
    const y1 = edge.from.y + 23
    const x2 = edge.to.x
    const y2 = edge.to.y + 23
    const mid = (x1 + x2) / 2
    svg.append(makeSvg("path", {
      d: `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`,
      class: `tree-edge${ancestors.has(edge.to.id) ? " is-selected" : ""}`
    }))
  }
  for (const node of layout.nodes) {
    const group = makeSvg("g", {
      class: `tree-node node-${node.category}${node.id === selected ? " is-selected" : ""}`,
      transform: `translate(${node.x}, ${node.y})`,
      "data-node": node.id,
      role: "button",
      tabindex: 0,
      "aria-label": `${node.name}, range ${node.from} to ${node.to}${node.folded ? ", collapsed" : ""}`,
      "aria-pressed": node.id === selected
    })
    group.append(
      makeSvg("title", {}, `${node.name} [${node.from}, ${node.to})`),
      makeSvg("rect", {width: 170, height: 46, rx: 8}),
      makeSvg("text", {x: 12, y: 19}, node.name.length > 23 ? `${node.name.slice(0, 21)}…` : node.name),
      makeSvg("text", {x: 12, y: 34, class: "node-range"}, `[${node.from}, ${node.to})`)
    )
    if (node.folded) group.append(makeSvg("text", {x: 149, y: 33, class: "node-fold"}, "+"))
    svg.append(group)
  }
  $("tree-summary").textContent = layout.truncated
    ? `First ${layout.nodes.length} visible nodes · collapse branches to explore more`
    : `${layout.nodes.length} visible / ${data.all.length} total nodes · ${$("markers").checked ? "punctuation included" : "punctuation hidden"}`
  updateZoom()
}

function selectNode(id, reveal = false) {
  if (sourcePending) return
  selected = id
  for (let parent = data.all[id].parent; parent != null; parent = data.all[parent].parent) collapsed.delete(parent)
  updateInspector()
  renderTree()
  if (!reveal) {
    const line = source.value.slice(0, data.all[id].from).split("\n").length - 1
    const top = 17 + line * 25
    if (top < source.scrollTop || top + 25 > source.scrollTop + source.clientHeight) {
      source.scrollTop = Math.max(0, top - source.clientHeight / 2)
    }
    const mark = $("source-overlay").querySelector("mark").getClientRects()[0]
    const input = source.getBoundingClientRect()
    if (mark && (mark.left < input.left + 14 || mark.left > input.right - 48)) {
      source.scrollLeft = Math.max(0, source.scrollLeft + mark.left - input.left - 14)
    }
    syncSourceScroll()
  }
  if (reveal) {
    const element = svg.querySelector(`[data-node="${id}"]`)
    const point = layout.nodes.find(node => node.id === id)
    if (element && point) viewport.scrollTo({left: Math.max(0, point.x * zoom - viewport.clientWidth / 2 + 85 * zoom), top: Math.max(0, point.y * zoom - viewport.clientHeight / 2 + 23 * zoom), behavior: "smooth"})
  }
}

function renderSteps() {
  const pos = job.parsedPos
  const length = source.value.length
  $("step-position").textContent = `${pos} / ${length}`
  const percent = length ? pos / length * 100 : stepFinished ? 100 : 0
  $("step-progress-fill").style.width = `${percent}%`
  document.querySelector(".step-progress").setAttribute("aria-valuenow", Math.round(percent))
  $("step-status").textContent = stepFinished ? "Tree returned" : stepCalls ? `advance() call ${stepCalls}` : "Ready to begin"
  $("next-step").disabled = stepFinished || sourcePending
  $("finish-steps").disabled = stepFinished || sourcePending
  const blocks = data.root.children
  const lastDone = blocks.findLastIndex(block => block.to <= pos)
  $("block-timeline").replaceChildren(...blocks.map((block, index) => {
    const tile = document.createElement("div")
    const done = block.to <= pos && stepCalls > 0
    tile.className = `timeline-block${done ? " is-done" : ""}${done && index === lastDone ? " is-current" : ""}`
    const number = document.createElement("span")
    number.className = "block-number"
    number.textContent = `${String(index + 1).padStart(2, "0")} / ${done ? "processed" : "waiting"}`
    const label = document.createElement("strong")
    label.textContent = block.name
    const range = document.createElement("small")
    range.textContent = `[${block.from}, ${block.to})`
    tile.append(number, label, range)
    return tile
  }))
  if (!blocks.length) $("block-timeline").textContent = "No child nodes in this document. The job still returns a document tree."
}

function resetSteps() {
  job = activeParser.startParse(source.value)
  stepCalls = 0
  stepFinished = false
  $("step-result").textContent = "The lazy job has been created. No advance() calls yet."
  renderSteps()
}

function advanceStep(render = true) {
  if (stepFinished || sourcePending) return
  const previousPos = job.parsedPos
  const result = job.advance()
  stepCalls++
  stepFinished = result !== null
  if (result) {
    const same = JSON.stringify(treeSnapshot(result)) === JSON.stringify(treeSnapshot(tree))
    $("step-result").textContent = same
      ? "A Tree was returned. Node names and ranges match the full parse above."
      : "The stepped result differs from the full parse. Restart to try again."
  } else {
    $("step-result").textContent = `advance() → null · parsedPos ${previousPos} → ${job.parsedPos}. Another call is needed, even if all blocks have been processed.`
  }
  if (render) renderSteps()
}

function parseSource(fit = false) {
  clearTimeout(debounce)
  sourcePending = false
  const started = performance.now()
  try {
    tree = activeParser.parse(source.value)
    const duration = performance.now() - started
    data = readTree(tree)
    collapsed.clear()
    selected = data.all.find(node => node.name === "strong")?.id ?? 0
    $("line-numbers").textContent = source.value.split("\n").map((_, index) => index + 1).join("\n") + "\n"
    $("metric-nodes").textContent = data.all.length
    $("metric-blocks").textContent = data.root.children.length
    $("metric-time").textContent = duration.toFixed(2)
    setStatus("Live parse")
    renderTree()
    updateInspector()
    resetSteps()
    if (fit) {
      // Keep labels readable on narrow screens; the canvas can scroll sideways.
      if (viewport.clientWidth < 500) {
        zoom = 1
        updateZoom()
        viewport.scrollTo(0, 0)
      } else fitTree()
    }
  } catch (error) {
    sourcePending = true
    setStatus("Parse failed", true)
    $("selected-description").textContent = error.message
    $("next-step").disabled = true
    $("finish-steps").disabled = true
  }
}

function loadSample() {
  const sample = samples[$("sample").value]
  source.value = sample.source
  source.scrollTop = 0
  source.scrollLeft = 0
  $("sample-description").textContent = sample.description
  parseSource(true)
}

function renderIncremental() {
  const after = editApplied ? incrementalSource.replace("small", "focused") : incrementalSource
  const comparison = compareEdit(activeParser, incrementalSource, after)
  $("edit-old").hidden = !editApplied
  $("edit-new").textContent = editApplied ? "focused" : "small"
  $("edit-new").style.background = editApplied ? "" : "transparent"
  $("edit-new").style.color = editApplied ? "" : "inherit"
  $("toggle-edit").textContent = editApplied ? "Undo the edit" : "Apply the edit"
  $("reuse-count").textContent = `${comparison.reused} / ${comparison.blocks.length}`
  $("reuse-verification").textContent = comparison.matchesFullParse
    ? editApplied ? "✓ Incremental and full parses have identical node names and ranges." : "✓ No edit: the original tree is returned unchanged."
    : "The incremental tree differs from a full parse."
  $("reuse-blocks").replaceChildren(...comparison.blocks.map((block, index) => {
    const element = document.createElement("div")
    element.className = `reuse-block${block.reused ? "" : " is-reparsed"}`
    const name = document.createElement("strong")
    name.textContent = block.name
    const range = document.createElement("span")
    range.textContent = `[${block.from}, ${block.to})`
    const status = document.createElement("small")
    status.textContent = `${index + 1} / ${block.reused ? "same object" : "new object"}`
    element.append(name, range, status)
    element.title = after.slice(block.from, block.to)
    return element
  }))
}

for (const [key, sample] of Object.entries(samples)) {
  const option = document.createElement("option")
  option.value = key
  option.textContent = sample.label
  $("sample").append(option)
}

for (const button of document.querySelectorAll("[data-stage]")) {
  button.addEventListener("click", () => {
    for (const stage of document.querySelectorAll("[data-stage]")) {
      stage.classList.toggle("is-active", stage === button)
      stage.setAttribute("aria-pressed", stage === button)
    }
    const [file, description] = stages[button.dataset.stage]
    $("stage-file").textContent = file
    $("stage-description").textContent = description
  })
}

source.addEventListener("input", () => {
  clearTimeout(debounce)
  sourcePending = true
  $("source-overlay").textContent = source.value + "\n"
  $("next-step").disabled = true
  $("finish-steps").disabled = true
  setStatus("Editing…")
  debounce = setTimeout(() => parseSource(), 180)
})
source.addEventListener("scroll", syncSourceScroll)
function selectAtCursor() {
  if (sourcePending) return
  const position = source.selectionStart
  const node = tree.resolveInner(position, position === source.value.length ? -1 : 1)
  const item = data.all.find(item => item.from === node.from && item.to === node.to && item.name === node.name)
  if (item) {
    if (item.category === "marker") $("markers").checked = true
    selectNode(item.id, true)
  }
}
source.addEventListener("click", selectAtCursor)
source.addEventListener("keyup", event => {
  if (/^(Arrow|Home|End)/.test(event.key)) selectAtCursor()
})
svg.addEventListener("click", event => {
  const node = event.target.closest("[data-node]")
  if (node) {
    selectNode(Number(node.dataset.node))
    svg.querySelector(`[data-node="${node.dataset.node}"]`)?.focus({preventScroll: true})
  }
})
svg.addEventListener("keydown", event => {
  const node = event.target.closest("[data-node]")
  if (!node || !["Enter", " ", "ArrowLeft", "ArrowRight"].includes(event.key)) return
  event.preventDefault()
  const id = Number(node.dataset.node)
  if (event.key === "ArrowLeft") collapsed.add(id)
  if (event.key === "ArrowRight") collapsed.delete(id)
  selectNode(id)
  svg.querySelector(`[data-node="${id}"]`)?.focus()
})

$("sample").addEventListener("change", loadSample)
$("reset-source").addEventListener("click", loadSample)
$("citations").addEventListener("change", () => {
  activeParser = parser.configure({extensions: $("citations").checked ? ["raw", "citations"] : ["raw"]})
  document.querySelector(".source-options > span").textContent = $("citations").checked ? "raw + citations" : "raw"
  parseSource(true)
  renderIncremental()
})
$("markers").addEventListener("change", () => {if (!sourcePending) {renderTree(); fitTree()}})
$("toggle-branch").addEventListener("click", () => {
  if (sourcePending) return
  if (collapsed.has(selected)) collapsed.delete(selected)
  else collapsed.add(selected)
  renderTree()
  updateInspector()
})
$("expand-tree").addEventListener("click", () => {if (!sourcePending) {collapsed.clear(); renderTree(); fitTree()}})
$("zoom-out").addEventListener("click", () => {zoom = Math.max(.45, zoom - .1); updateZoom()})
$("zoom-in").addEventListener("click", () => {zoom = Math.min(1.5, zoom + .1); updateZoom()})
$("fit-tree").addEventListener("click", fitTree)
$("next-step").addEventListener("click", advanceStep)
$("finish-steps").addEventListener("click", () => {
  while (!stepFinished && !sourcePending) advanceStep(false)
  renderSteps()
})
$("reset-steps").addEventListener("click", () => {if (!sourcePending) resetSteps()})
$("toggle-edit").addEventListener("click", () => {editApplied = !editApplied; renderIncremental()})
loadSample()
renderIncremental()
