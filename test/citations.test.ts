import { readFileSync } from "node:fs"
import { type Tree, TreeFragment } from "@lezer/common"
import { parser } from "lezer-carve"
import { describe, expect, it } from "vitest"
import { checkInvariants, findNode, findNodes, nodeNames } from "./helpers.js"

const citations = parser.configure({ extensions: ["raw", "citations"] })

function parse(source: string): Tree {
  const tree = citations.parse(source)
  checkInvariants(source, tree)
  return tree
}

function labels(source: string): string[] {
  return findNodes(parse(source), "citation_label").map(n => source.slice(n.from, n.to))
}

function snapshot(tree: Tree): [string, number, number][] {
  const nodes: [string, number, number][] = []
  tree.cursor().iterate(n => nodes.push([n.name, n.from, n.to]))
  return nodes
}

describe("optional citations", () => {
  it("requires an explicit extension and reserves @-first link definitions in core", () => {
    const source = "See [@a].\n\n[@a]: Entry."
    for (const configured of [parser, parser.configure({ extensions: [] })]) {
      const tree = configured.parse(source)
      expect(nodeNames(tree).some(n => n.startsWith("citation_"))).toBe(false)
      expect(findNode(tree, "link_reference_definition")).toBeNull()
      expect(findNode(tree, "collapsed_reference_link")).toBeNull()
    }
    expect(labels(source)).toEqual(["a", "a"])
  })

  it.each([
    ["[@smith2020]", ["smith2020"]],
    ["[see *also* @a, pp. 4–5; -@b; +@c]", ["a", "b", "c"]],
    ["[+@a; @b] then [@a; +@b] then [+-@k]", ["a", "b", "a", "b", "k"]],
    ["[@a:b.c#d$e%f&g+h?i<j>k~l/m-n_]", ["a:b.c#d$e%f&g+h?i<j>k~l/m-n_"]],
    ["[see\n@a]", ["a"]],
    ["[@a,]", ["a"]],
    ["[@0; @_key; @Case]", ["0", "_key", "Case"]],
    ["[@a\u00a0]", ["a"]],
    [String.raw`[escaped \@a, see @b]`, ["b"]],
    [String.raw`[\\@a]`, ["a"]],
    ["[@a, [x]] [see [y] @b]", ["a", "b"]]
  ])("parses keys and inline item content in %s", (source, expected) => {
    expect(labels(source)).toEqual(expected)
  })

  it("parses markup in prefixes and locators and keeps key ranges free of markers", () => {
    const source = "[see *also* -@Smith, /p. 4/; @b]"
    const tree = parse(source)
    expect(findNodes(tree, "strong")).toHaveLength(1)
    expect(findNodes(tree, "emphasis")).toHaveLength(1)
    expect(labels(source)).toEqual(["Smith", "b"])
    expect(findNodes(tree, "link_mark").map(n => source.slice(n.from, n.to))).toEqual([
      "[",
      "-@",
      ",",
      ";",
      "@",
      "]"
    ])
  })

  it.each([
    "[@]",
    "[@-bad]",
    "[@a , p. 4]",
    "[@a, p. 1; 2]",
    "[@a; bad; @b]",
    "[@a;]",
    "[;@a]",
    String.raw`[\@a]`,
    String.raw`[@a\,b]`,
    "@a",
    "![ @a ]",
    "[@a](url)",
    "[@a][ref]",
    "[@a][]",
    "[@a]{.ref}",
    "[@a]{unfinished",
    "[t][@a]",
    "![t][@a]",
    "[@a](unfinished",
    "`[@a]`",
    "!`[@a]`",
    "$`[@a]`",
    "{=html}[@a]{=html}",
    "{# [@a] #}",
    "{% [@a] %}",
    "```\n[@a]\n```",
    "%% [@a]"
  ])("declines reserved, malformed or opaque source %s", source => {
    expect(findNodes(parse(source), "citation_group")).toEqual([])
  })

  it("keeps reference-label tails literal as a unit with or without the extension", () => {
    const source = "[t][@a] ![t][@a] [@a]"
    expect(labels(source)).toEqual(["a"])
    for (const configured of [parser, citations]) {
      expect(findNodes(configured.parse(source), "full_reference_link")).toEqual([])
      expect(findNodes(configured.parse(source), "full_reference_image")).toEqual([])
    }
  })

  it("reserves @-first implicit reference labels for links and images", () => {
    for (const configured of [parser, citations]) {
      const source = "[@a][] ![@a][] ![@a]"
      const tree = configured.parse(source)
      checkInvariants(source, tree)
      expect(findNodes(tree, "collapsed_reference_link")).toEqual([])
      expect(findNodes(tree, "collapsed_reference_image")).toEqual([])
      expect(findNodes(tree, "citation_group")).toEqual([])
    }
  })

  it("recognizes single-line entries with optional metadata and inline markup", () => {
    const source = '[@a]: {author="Smith" year="2020"} Smith. *Title*.\ncontinued\n[@b]:\n'
    const tree = parse(source)
    expect(findNodes(tree, "citation_definition")).toHaveLength(2)
    expect(findNodes(tree, "citation_entry").map(n => source.slice(n.from, n.to))).toEqual([
      "Smith. *Title*."
    ])
    expect(findNodes(tree, "inline_attribute")).toHaveLength(1)
    expect(findNodes(tree, "key_value")).toHaveLength(2)
    expect(findNodes(tree, "strong")).toHaveLength(1)
    expect(findNodes(tree, "paragraph").map(n => source.slice(n.from, n.to))).toEqual(["continued"])
  })

  it.each(["[@]: Entry", "[@bad key]: Entry", "[@-bad]: Entry", "  [@a]: Entry"])(
    "does not promote invalid or document-indented definitions %s",
    source => {
      expect(findNodes(parse(source), "citation_definition")).toEqual([])
      expect(findNodes(parse(source), "link_reference_definition")).toEqual([])
    }
  )

  it("works inside quotes, lists, footnotes, headings and table cells", () => {
    const source =
      "> [@a]: Entry\n> See [@a].\n\n- [@b]: Book\n\n[^n]: See [@b].\n\n# Title [@a]\n\n| [@b] |\n"
    const tree = parse(source)
    expect(findNodes(tree, "citation_definition")).toHaveLength(2)
    expect(findNodes(tree, "citation_group")).toHaveLength(4)
  })

  it("covers the citation vocabulary with an opt-in fixture", () => {
    const source = readFileSync(new URL("./fixtures/citations.crv", import.meta.url), "utf8")
    expect(labels(source)).toEqual([
      "smith2020",
      "jones2019",
      "doe2021",
      "smith2020",
      "jones2019",
      "doe2021"
    ])
  })

  it("preserves inner citations behind many rejected bracket wrappers", () => {
    const source = `${"[".repeat(12000)}@a${"]".repeat(12000)}`
    const start = performance.now()
    expect(labels(source)).toEqual(["a"])
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it("declines deeply nested invalid item lists without rescanning each wrapper", () => {
    const source = `${"[".repeat(12000)}@a; bad; @b,${"]".repeat(12000)}`
    const start = performance.now()
    expect(labels(source)).toEqual([])
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it("keeps deeply nested citation prefixes within its recursion budget", () => {
    const source = `${"[see ".repeat(1000)}@a${" @b]".repeat(1000)}`
    const tree = parse(source)
    expect(findNodes(tree, "citation_group").length).toBeGreaterThan(0)
  })

  it("handles unmatched openers and repeated nested prefixes efficiently", () => {
    for (const fragment of ["[@a ", "[see [x] @a] ", "_[b]_ [@a] ", "[a *[b]*](u) [@a] "]) {
      const source = fragment.repeat(12000)
      const start = performance.now()
      parse(source)
      expect(performance.now() - start, fragment).toBeLessThan(2000)
    }
  })

  it("maps citation keys across disjoint parse ranges", () => {
    const source = "outside [@EXCLUDEDsmith] outside\n[@smith]: Book"
    const from = source.indexOf("[@"),
      next = source.indexOf("smith"),
      close = source.indexOf("]") + 1
    const tree = citations.parse(
      source,
      [],
      [
        { from, to: from + 2 },
        { from: next, to: close }
      ]
    )
    checkInvariants(source.slice(from, close), tree)
    expect(findNode(tree, "citation_label")).toMatchObject({
      from: next - from,
      to: close - from - 1
    })
  })

  it("keeps bounds and output deterministic on arbitrary citation punctuation", () => {
    const fragments = [
      "[@a]",
      "[@a]: ",
      "[+",
      "-@b",
      "@c,",
      ";",
      "[",
      "]",
      "{author=x}",
      "*",
      "`",
      "\\",
      "\\\\",
      "> ",
      "- ",
      "| ",
      "\n",
      "\r",
      "\u00a0",
      " text "
    ]
    let seed = 0xabc123
    for (let n = 0; n < 5000; n++) {
      let source = ""
      for (let i = 0; i < 20; i++) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        source += fragments[(seed >>> 0) % fragments.length]
      }
      try {
        expect(snapshot(parse(source))).toEqual(snapshot(parse(source)))
      } catch (error) {
        throw new Error(JSON.stringify(source), { cause: error })
      }
    }
  })

  it("matches full parses after edits to groups, entries and feature configuration", () => {
    const source = "# Heading\n\n[see @a, p. 4; -@b]\n\n[@a]: *Book*.\n\n[@b]: Other.\n"
    const old = parse(source)
    for (let from = 0; from <= source.length; from++) {
      const to = Math.min(source.length, from + 1)
      for (const insert of ["", "@", ";", "\n", "x"]) {
        const changed = source.slice(0, from) + insert + source.slice(to)
        const fragments = TreeFragment.applyChanges(
          TreeFragment.addTree(old),
          [{ fromA: from, toA: to, fromB: from, toB: from + insert.length }],
          0
        )
        const incremental = citations.parse(changed, fragments)
        checkInvariants(changed, incremental)
        expect(snapshot(incremental)).toEqual(snapshot(parse(changed)))
        expect(snapshot(parser.parse(changed, fragments))).toEqual(snapshot(parser.parse(changed)))
      }
    }
  })
})
