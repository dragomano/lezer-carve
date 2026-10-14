import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Input, NodeProp, type Tree, TreeFragment } from "@lezer/common"
import { parser } from "lezer-carve"
import { describe, expect, it } from "vitest"
import { checkInvariants } from "./helpers.js"

function snapshot(tree: Tree): [string, number, number][] {
  const nodes: [string, number, number][] = []
  tree.cursor().iterate(node => {
    nodes.push([node.name, node.from, node.to])
  })
  return nodes
}

function edit(doc: string, tree: Tree, from: number, to: number, insert: string) {
  const changed = doc.slice(0, from) + insert + doc.slice(to)
  const fragments = TreeFragment.applyChanges(
    TreeFragment.addTree(tree),
    [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }],
    0
  )
  const incremental = parser.parse(changed, fragments)
  const full = parser.parse(changed)
  checkInvariants(changed, incremental)
  expect(snapshot(incremental), JSON.stringify({ doc, from, to, insert })).toEqual(snapshot(full))
  return { doc: changed, tree: incremental }
}

describe("incremental blocks", () => {
  it("reuses a completely unchanged tree without reading the input", () => {
    const doc = "# Heading\n\nSome *text*.\n\n- item\n"
    const tree = parser.parse(doc)
    const input: Input = {
      length: doc.length,
      lineChunks: false,
      read() {
        throw new Error("Unchanged input was read")
      },
      chunk() {
        throw new Error("Unchanged input was read")
      }
    }
    expect(parser.parse(input, TreeFragment.addTree(tree))).toBe(tree)
  })

  it("reuses unchanged blocks before and after an edited paragraph", () => {
    const doc = Array.from({ length: 100 }, (_, i) => `Paragraph ${i} with *bold*.\n\n`).join("")
    const old = parser.parse(doc)
    const pos = doc.indexOf("Paragraph 50") + 10
    const result = edit(doc, old, pos, pos + 1, "x")
    const reused = result.tree.children.filter(child => old.children.includes(child)).length
    expect(reused).toBeGreaterThanOrEqual(97)
    expect(result.tree.children[0]).toBe(old.children[0])
    expect(result.tree.children[99]).toBe(old.children[99])
  })

  it("maps reused blocks after insertions and deletions", () => {
    const doc = "# One\n\ntext\n\n# Two\n\nbody\n\n# Three\n\nend\n"
    const result = edit(
      doc,
      parser.parse(doc),
      doc.indexOf("text"),
      doc.indexOf("text") + 4,
      "longer\ntext"
    )
    edit(
      result.doc,
      result.tree,
      result.doc.indexOf("longer"),
      result.doc.indexOf("longer") + 7,
      ""
    )
  })

  it("reuses frontmatter when a later block is edited", () => {
    const doc = "--- yaml\nkey: value\n---\n\n# Heading\n\ntext\n"
    const old = parser.parse(doc)
    const pos = doc.indexOf("text")
    const result = edit(doc, old, pos, pos + 4, "changed")
    expect(result.tree.children[0]).toBe(old.children[0])
  })

  it("reuses a closed comment fence independently of later blocks", () => {
    const doc = "%%%\ncomment\n%%%\n\ntext\n\n# Tail\n",
      old = parser.parse(doc)
    const from = doc.indexOf("text")
    const result = edit(doc, old, from, from + 4, "changed")
    expect(result.tree.children[0]).toBe(old.children[0])
  })

  it("advances lazily and stops after a complete block", () => {
    const doc = "# One\n\n# Two\n\n# Three\n"
    let reads = 0
    const input: Input = {
      length: doc.length,
      lineChunks: false,
      chunk: pos => doc.slice(pos),
      read(from, to) {
        reads++
        return doc.slice(from, to)
      }
    }
    const partial = parser.startParse(input)
    expect(reads).toBe(0)
    expect(partial.parsedPos).toBe(0)
    partial.stopAt(3)
    expect(partial.advance()).toBeNull()
    expect(partial.parsedPos).toBeGreaterThanOrEqual(3)
    const tree = partial.advance()!
    expect(tree.length).toBeLessThan(doc.length)
    expect(tree.toString()).toBe("document(heading(marker,content))")
    expect(() => partial.stopAt(4)).toThrow(RangeError)
    const fragments = TreeFragment.addTree(tree, [], true)
    expect(snapshot(parser.parse(doc, fragments))).toEqual(snapshot(parser.parse(doc)))
  })

  it("does not reuse blocks under a different configuration", () => {
    const doc = "{=html}<b>raw</b>{=html}\n\ntext\n"
    const old = parser.parse(doc)
    const configured = parser.configure({ extensions: [] })
    const tree = configured.parse(doc, TreeFragment.addTree(old))
    expect(snapshot(tree)).toEqual(snapshot(configured.parse(doc)))
    expect(tree.children.some(child => old.children.includes(child))).toBe(false)
    const prop = new NodeProp<string>()
    const withProps = parser.configure({
      props: [prop.add(type => (type.isTop ? "configured" : undefined))]
    })
    expect(withProps.topType.prop(prop)).toBe("configured")
  })

  it("supports fragment offsets for a contiguous nested range", () => {
    const doc = "outside\n# One\n\ntext\n\n# Two\n\noutside"
    const from = doc.indexOf("# One"),
      to = doc.lastIndexOf("outside")
    const old = parser.parse(doc, [], [{ from, to }])
    const pos = doc.indexOf("text")
    const changed = `${doc.slice(0, pos)}long ${doc.slice(pos)}`
    const fragments = TreeFragment.applyChanges(
      [new TreeFragment(from, to, old, -from)],
      [{ fromA: pos, toA: pos, fromB: pos, toB: pos + 5 }],
      0
    )
    const actual = parser.parse(changed, fragments, [{ from, to: to + 5 }])
    expect(snapshot(actual)).toEqual(snapshot(parser.parse(changed, [], [{ from, to: to + 5 }])))
    expect(actual.children[0]).toBe(old.children[0])
  })

  it("does not reuse a disjoint parse as a contiguous parse", () => {
    const doc = "/one/EXCLUDED*two*"
    const old = parser.parse(
      doc,
      [],
      [
        { from: 0, to: 5 },
        { from: doc.indexOf("*two*"), to: doc.length }
      ]
    )
    expect(snapshot(parser.parse(doc, TreeFragment.addTree(old)))).toEqual(
      snapshot(parser.parse(doc))
    )
  })

  it("reuses blocks across many changed fragments with different offsets", () => {
    const paragraphs = Array.from({ length: 1000 }, (_, n) => `Paragraph ${n}.\n\n`)
    const doc = paragraphs.join(""),
      old = parser.parse(doc)
    const changes: { fromA: number; toA: number; fromB: number; toB: number }[] = []
    let changed = "",
      fromA = 0
    for (let n = 0; n < paragraphs.length; n++) {
      const text = paragraphs[n]
      if (n % 10 === 0) {
        const insert = n % 20 === 0 ? "extra " : "x"
        const fromB = changed.length
        changed += insert + text
        changes.push({ fromA, toA: fromA, fromB, toB: fromB + insert.length })
      } else changed += text
      fromA += text.length
    }
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(old), changes, 0)
    const actual = parser.parse(changed, fragments)
    checkInvariants(changed, actual)
    expect(snapshot(actual)).toEqual(snapshot(parser.parse(changed)))
    expect(actual.children.filter(child => old.children.includes(child)).length).toBeGreaterThan(
      750
    )
  })

  const cases = [
    "|a|b|\n| a\\|b | `c|d` |\n\n# Tail\n",
    '|=<{title="a | b" .x} *cell* | data |\n\n# Tail\n',
    "<b>literal</b> and <https://example.com>\n\n# Tail\n",
    "text [~`~[x]` and _*bold*_\n\n# Tail\n",
    "--- junk value\nkey: value\n---\n\n# Tail\n",
    'text {title="first\r\nsecond"}\n\n# Tail\n',
    "::: outer\n::: inner\nbody\n:::\nouter tail\n:::\n\n# Tail\n",
    "::: note\n```js\n:::\n````\n:::\n\n# Tail\n",
    "- item\n+\n::: outer\n::: inner\nbody\n:::\n:::\n- next\n",
    "```js\n\n```\n\n# Tail\n",
    "~~~ =html\n<b>raw</b>\n~~~~\n\n# Tail\n",
    "%%% note\n:::\n  %%% end\n\n# Tail\n",
    "[text](a\"b 'title ) with \\'quote\\'')\n\n# Tail\n",
    ":: First\n:: Alias\n: Shared\n:: Second\n: Own\n\n# Tail\n",
    "# One\r\rtext\\\rnext\r\r# Two\r",
    "\uFEFF```js\r\nx\r\n```\r\n\r\n# Tail\r\n",
    "---yaml\nscalar\n---\n\n# Heading\n",
    "---\n \t\nkey: value\n---\n\n# Heading\n",
    "text *a** tail* and /*a\\*/ tail*/\n\n# Heading\n",
    "[a `]` label](url)\n\n# Heading\n",
    '[text](url "a ) title" )\n\n# Heading\n',
    "[text]{unfinished\n\n# Heading\n",
    "#\tTitle\n\n#\t\n",
    "```\tjs\nconst x = 1\n```\n\n# Heading\n",
    "text {:en} [link][] ![image](url)\n\n# Heading\n",
    "- item\n+\n::: note\nbody\n:::\n- next\n",
    "> | a |\n> |---|---|\n> | b |\n\n# Heading\n",
    "> [^f]: first\n>   second\n\n# Heading\n",
    "> - first\n>   second\n\n# Heading\n",
    "- [reference] text\n* next\n\n# Heading\n",
    "---\nkey: value\n\n# Heading\n",
    "--- yaml\nkey: value\n---\n\n# Heading\n",
    "```js\nconst x = 1\n```\n\n# Heading\n",
    "```\nbody\n\n# Heading\n",
    "- one\n\n- two\n\n# Heading\n",
    "- one\n  ```\n  code\n  ```\n\n# Heading\n",
    "> quote\n>\n> - item\n\n# Heading\n",
    "::: note\nbody\n:::\n\n# Heading\n",
    "%%%\ncomment\n%%%\n\n# Heading\n",
    "[^note]: text\n\n  continuation\n\n# Heading\n",
    "|= Header |\n| Value |\n^ Caption\n\n# Heading\n",
    "\uFEFF# Heading\r\n\r\ntext\r\n",
    "# Heading\n\n/one/*two*\n",
    "\n\n",
    ""
  ]
  for (const doc of cases) {
    it(`matches full parsing after boundary edits: ${JSON.stringify(doc)}`, () => {
      const tree = parser.parse(doc)
      for (let pos = 0; pos <= doc.length; pos++) {
        for (const insert of ["\n", " ", "`", "-", ">", "---\n"]) edit(doc, tree, pos, pos, insert)
        if (pos < doc.length) edit(doc, tree, pos, pos + 1, "")
      }
    })
  }

  it("matches full parsing through sequential edits of real fixtures", () => {
    const bases: string[] = []
    for (const sub of ["corpus", "fixtures"]) {
      const dir = fileURLToPath(new URL(`./${sub}`, import.meta.url))
      for (const name of readdirSync(dir)) {
        if (/\.(?:md|crv)$/.test(name)) bases.push(readFileSync(`${dir}/${name}`, "utf8"))
      }
    }
    let seed = 123456789
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x100000000
    }
    const chars = " \n\r\t#>|-=+*~`[]{}\\^$:.,!?()_abZ019\uFEFF"
    for (const base of bases) {
      let doc = base,
        tree = parser.parse(doc)
      for (let i = 0; i < 60; i++) {
        const from = Math.floor(random() * (doc.length + 1))
        const to = Math.min(doc.length, from + (random() < 0.5 ? 1 : 0))
        const insert = random() < 0.3 ? "" : chars[Math.floor(random() * chars.length)]
        const next = edit(doc, tree, from, to, insert)
        doc = next.doc
        tree = next.tree
      }
    }
  })
})
