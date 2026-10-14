import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkInvariants, checkNoErrors, type NodeRef, nodeNames, parse } from "./helpers.js"

/**
 * Conformance against `markup-carve/carve`'s own layout fixtures.
 *
 * This is the oracle the other corpora are not. `test/corpus` holds inputs
 * whose only expected output is rendered HTML, and HTML cannot distinguish a
 * node the parser produced from text that merely renders the same way — so
 * those cases can only check that nothing crashes. These fixtures state node
 * paths and byte ranges, which is a statement about the tree itself.
 *
 *   curl -Lo test/data/ast-source-layout-fixtures.json \
 *     https://raw.githubusercontent.com/markup-carve/carve/main/resources/ast-source-layout-fixtures.json
 */
const fixturesFile = fileURLToPath(
  new URL("./data/ast-source-layout-fixtures.json", import.meta.url)
)
const haveFixtures = existsSync(fixturesFile)

interface LayoutNode {
  path: string
  startByte: number
  endByte: number
}

interface LayoutFixture {
  name: string
  source: string
  layout: { nodes: LayoutNode[] }
}

interface SourceFact {
  name: string
  source: string
  lineEndings: string
  bom: boolean
}

const fixtures: { exact: LayoutFixture[]; sourceFacts: SourceFact[] } = haveFixtures
  ? JSON.parse(readFileSync(fixturesFile, "utf8"))
  : { exact: [], sourceFacts: [] }

/**
 * Every node in the tree, keyed by the JSON pointer the fixtures use:
 * `/children/0` is the root's first child, `/children/0/children/1` its second.
 */
function index(tree: ReturnType<typeof parse>): Map<string, NodeRef> {
  const byPath = new Map<string, NodeRef>()
  const path: number[] = []
  const cursor = tree.cursor()
  let stack = ""
  for (;;) {
    const node = cursor.node
    if (!byPath.has(stack)) {
      byPath.set(stack, { name: node.name, from: node.from, to: node.to, parent: null })
    }
    if (cursor.firstChild()) {
      path.push(0)
      stack = path.map(i => `/children/${i}`).join("")
      continue
    }
    while (!cursor.nextSibling()) {
      if (!cursor.parent()) return byPath
      path.pop()
      stack = path.map(i => `/children/${i}`).join("")
    }
    path[path.length - 1]++
    stack = path.map(i => `/children/${i}`).join("")
  }
}

describe("layout indexing", () => {
  it("tracks sibling paths at every depth", () => {
    const source = "# One\n\n# Two"
    const nodes = index(parse(source))
    expect(nodes.get("/children/1")).toMatchObject({ name: "heading", from: 7, to: 12 })
    expect(nodes.get("/children/0/children/1")).toMatchObject({ name: "content", from: 2, to: 5 })
    expect(nodes.get("/children/1/children/1")).toMatchObject({ name: "content", from: 9, to: 12 })
  })
})

describe.skipIf(!haveFixtures)("upstream layout fixtures", () => {
  it("ships fixtures to check against", () => {
    expect(fixtures.exact.length + fixtures.sourceFacts.length).toBeGreaterThan(0)
  })

  for (const fixture of fixtures.exact) {
    it(`matches the exact layout of "${fixture.name}"`, () => {
      const source = fixture.source
      const tree = parse(source)
      checkInvariants(source, tree)
      const byPath = index(tree)
      for (const want of fixture.layout.nodes) {
        const got = byPath.get(want.path)
        expect(got, `${want.path} is missing`).toBeDefined()
        // Lezer uses UTF-16 positions; the fixture oracle uses UTF-8 bytes.
        expect(Buffer.byteLength(source.slice(0, got!.from)), `${want.path} start`).toBe(
          want.startByte
        )
        expect(Buffer.byteLength(source.slice(0, got!.to)), `${want.path} end`).toBe(want.endByte)
      }
    })
  }

  for (const fact of fixtures.sourceFacts) {
    it(`parses "${fact.name}" without errors`, () => {
      const source = fact.source
      const tree = parse(source)
      checkInvariants(source, tree)
      checkNoErrors(tree)
      expect(tree.length).toBe(source.length)
    })
  }
})

describe.skipIf(!haveFixtures)("upstream layout fixtures, shape", () => {
  // The byte ranges are upstream's; the shape below is what each named case is
  // in the specification. It is the part worth failing on, because a fixture
  // that stops being produced tells you nothing about whether it is still right.
  // `ascii paragraph` is covered by the exact layout check above and is not in
  // `sourceFacts`.
  const shape: Record<string, string[]> = {
    "utf8 bom and crlf": ["document", "list", "list_item", "list_marker_dash"],
    "mixed endings": ["document", "paragraph", "content"],
    "explicit continuation": [
      "document",
      "list",
      "list_item",
      "list_marker_dash",
      "list_item_content",
      "paragraph",
      "list_continuation_marker",
      "code_block",
      "language",
      "code"
    ],
    "marker-line fence": [
      "document",
      "list",
      "list_item",
      "list_marker_dash",
      "list_item_content",
      "div",
      "div_marker_begin",
      "admonition_type",
      "paragraph",
      "div_marker_end"
    ],
    "loose list": [
      "document",
      "list",
      "list_item",
      "list_marker_dash",
      "list_item_content",
      "paragraph"
    ],
    "table padding and orphan span": [
      "document",
      "table",
      "table_row",
      "table_cell",
      "table_separator"
    ]
  }

  for (const [name, expected] of Object.entries(shape)) {
    it(`produces the documented structure for "${name}"`, () => {
      const fact = fixtures.sourceFacts.find(f => f.name === name)
      expect(fact, `${name} is no longer in the fixture file`).toBeDefined()
      const names = nodeNames(parse(fact!.source))
      for (const node of expected) expect(names, node).toContain(node)
    })
  }

  it("skips a byte-order mark rather than letting it eat the first character", () => {
    const bom = fixtures.sourceFacts.find(f => f.bom)
    expect(bom, "no fixture declares a BOM any more").toBeDefined()
    const names = nodeNames(parse(bom!.source))
    // Without this, `- item` after a BOM parses as a paragraph.
    expect(names).toContain("list_item")
  })
})
