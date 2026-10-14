import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkInvariants, checkNoErrors, findNode, findNodes, nodeNames, parse } from "./helpers.js"

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

function readDir(relative: string, suffix: string): string[] {
  const dir = fileURLToPath(new URL(relative, import.meta.url))
  return readdirSync(dir)
    .filter(name => name.endsWith(suffix))
    .sort()
    .map(name => `${relative}/${name}`)
}

/**
 * `test/corpus/` holds the Markdown inputs of `markup-carve/carve`'s own
 * `tests/corpus-convert` suite, fetched from the upstream repository. They are
 * small, one construct each, and they are written by the people who maintain
 * the language — which makes them the sharpest check available that the parser
 * neither crashes nor misreads an edge case.
 *
 *   curl -o test/corpus.zip \
 *     https://codeload.github.com/markup-carve/carve/tar.gz/refs/heads/main
 *   tar -xzf test/corpus.zip --strip-components=1 carve-main/tests/corpus-convert
 *   # then move each input.md to test/corpus/<case name>.md
 */
const corpus = readDir("./corpus", ".md")

describe(`upstream corpus (${corpus.length} cases)`, () => {
  for (const path of corpus) {
    const name = path.slice("./corpus/".length, -3)
    it(name, () => {
      const source = read(path)
      const tree = parse(source)
      checkInvariants(source, tree)
      checkNoErrors(tree)
      expect(parse(source).toString()).toBe(tree.toString())
    })
  }
})

/** Whole documents, taken from the Carve project's own documentation. */
const documents = [
  ["demo.crv", read("./fixtures/demo.crv")],
  ["quick.crv", read("./fixtures/quick.crv")],
  ["release notes", read("./fixtures/release-notes.crv")]
] as const

describe("documents", () => {
  for (const [name, source] of documents) {
    it(`${name} parses into a sound tree`, () => {
      const tree = parse(source)
      checkInvariants(source, tree)
      checkNoErrors(tree)
      expect(tree.length).toBe(source.length)
    })

    it(`${name} parses identically on repeat`, () => {
      expect(parse(source).toString()).toBe(parse(source).toString())
    })
  }
})

/**
 * `demo.crv` is written to exercise the grammar, so it is the one document
 * that should produce every construct the parser knows about. A construct
 * going missing from this list is the signal that a test elsewhere has gone
 * stale.
 */
describe("demo.crv coverage", () => {
  const source = read("./fixtures/demo.crv")
  const tree = parse(source)
  const present = new Set(nodeNames(tree))

  const expected = [
    // blocks
    "frontmatter",
    "frontmatter_marker",
    "frontmatter_content",
    "heading",
    "marker",
    "block_attribute",
    "identifier",
    "class_name",
    "key_value",
    "thematic_break",
    "paragraph",
    "content",
    "code_block",
    "code_block_header",
    "language",
    "code_block_label",
    "raw_block",
    "raw_block_info",
    "div",
    "admonition_type",
    "div_title",
    "div_marker_begin",
    "div_marker_end",
    "block_quote",
    "block_quote_marker",
    "comment_line",
    "table",
    "table_header",
    "table_row",
    "table_cell",
    "table_caption",
    "caption_marker",
    "list",
    "list_item",
    "list_marker_dash",
    "list_marker_task",
    "checked",
    "unchecked",
    "definition_list",
    "term",
    "definition",
    "list_marker_definition",
    "list_marker_description",
    "caption",
    "footnote",
    "reference_label",
    "link_reference_definition",
    "link_label",
    "link_destination",
    "link_title",
    // inline
    "emphasis",
    "strong",
    "bold_italic",
    "underline",
    "strikethrough",
    "highlighted",
    "superscript",
    "subscript",
    "verbatim",
    "verbatim_marker_begin",
    "verbatim_marker_end",
    "math",
    "math_marker_begin",
    "math_marker_end",
    "inline_link",
    "link_text",
    "inline_link_destination",
    "autolink",
    "auto_text_link",
    "collapsed_reference_link",
    "full_reference_link",
    "inline_image",
    "span",
    "inline_attribute",
    "key",
    "value",
    "mention",
    "tag",
    "extension_inline",
    "args",
    "insert",
    "delete",
    "substitution",
    "editorial_comment",
    "backslash_escape",
    "ellipsis",
    "em_dash",
    "en_dash",
    "link_mark"
  ]

  it("produces every construct the document uses", () => {
    const missing = expected.filter(name => !present.has(name))
    expect(missing, `demo.crv no longer exercises: ${missing.join(", ")}`).toEqual([])
  })

  it("keeps nested constructs inside their container", () => {
    const div = findNode(tree, "div")!
    const inside = findNodes(tree, "paragraph").filter(p => p.from >= div.from && p.to <= div.to)
    expect(inside.length).toBeGreaterThan(0)
  })

  it("nests a container's code blocks inside it", () => {
    // `::: code-group` holds three fenced blocks; a fence that swallows the rest
    // of the document is the classic fence-closer bug.
    for (const block of findNodes(tree, "code_block")) {
      const parent = block.parent
      if (parent && parent.name === "div")
        expect(block.to, block.name).toBeLessThanOrEqual(parent.to)
    }
  })

  it("gives a task item the right checkbox state", () => {
    const checked = findNodes(tree, "checked").map(n => source.slice(n.from, n.to))
    const unchecked = findNodes(tree, "unchecked")
    expect(checked).toContain("x")
    expect(unchecked.length).toBeGreaterThan(0)
  })
})

describe("adversarial documents", () => {
  it("survives a document that is only whitespace", () => {
    for (const source of ["", "\n", "   ", "\n\n\n\n", "\t"]) {
      checkInvariants(source, parse(source))
    }
  })

  it("survives unterminated constructs of every kind", () => {
    for (const source of [
      "```js\nnever closed",
      "~~~yaml\nnever closed",
      "::: note\nnever closed",
      "> never closed",
      "%%% \nnever closed",
      "- item\n   - ",
      "[unclosed](",
      "[unclosed][",
      "`unclosed",
      "{#unclosed",
      "| a",
      ":: term",
      "[^fn]: "
    ]) {
      checkInvariants(`${source}\n`, parse(`${source}\n`))
    }
  })

  it("survives deeply nested containers", () => {
    for (const source of [
      `${"> ".repeat(30)}deep\n`,
      `${"- ".repeat(20)}deep\n`,
      `${"::: ".repeat(15)}deep\n`
    ]) {
      checkInvariants(source, parse(source))
    }
  })

  it("survives mixed line endings", () => {
    for (const source of ["# a\r\n# b\r\n", "# a\n# b\r\n\r# c\n", "\r\n# a\r\n"]) {
      checkInvariants(source, parse(source))
    }
  })

  it("parses a very long line", () => {
    const source = `${"x".repeat(200000)}\n`
    checkInvariants(source, parse(source))
  })

  it("parses a document with many top-level blocks", () => {
    const source = Array.from({ length: 20000 }, (_, i) => `# H${i}\n`).join("\n")
    checkInvariants(source, parse(source))
  })
})
