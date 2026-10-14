import { describe, expect, it } from "vitest"
import type { NodeRef } from "./helpers.js"
import {
  checkInvariants,
  checkNoErrors,
  findNode,
  findNodes,
  nodePathAt,
  parse
} from "./helpers.js"

/**
 * Parse `src`, assert the tree is structurally sound and error-free, and
 * return it together with a `text` helper that reads a node's source back.
 */
function parseOk(src: string) {
  const tree = parse(src)
  checkInvariants(src, tree)
  checkNoErrors(tree)
  return {
    tree,
    text: (node: NodeRef | null) => (node ? src.slice(node.from, node.to) : "<missing>")
  }
}

describe("document structure", () => {
  it("parses an empty document", () => {
    const tree = parse("")
    expect(tree.length).toBe(0)
    expect(tree.topNode.name).toBe("document")
  })

  it("covers a document that is only newlines", () => {
    const src = "\n\n\n"
    const { tree } = parseOk(src)
    expect(tree.length).toBe(src.length)
  })

  it("folds consecutive prose lines into one paragraph", () => {
    const { tree, text } = parseOk("First line\nsecond line\nthird line\n")
    const paras = findNodes(tree, "paragraph")
    expect(paras).toHaveLength(1)
    expect(text(paras[0])).toBe("First line\nsecond line\nthird line")
  })

  it("closes a paragraph at a blank line", () => {
    const { tree, text } = parseOk("One\n\nTwo\n")
    expect(findNodes(tree, "paragraph").map(text)).toEqual(["One", "Two"])
  })

  it("interrupts a paragraph at a heading", () => {
    const { tree } = parseOk("Intro text\n# Heading\nafter\n")
    expect(findNode(tree, "heading")).not.toBeNull()
    expect(findNodes(tree, "paragraph")).toHaveLength(2)
  })
})

describe("headings", () => {
  it("recognises all six levels", () => {
    for (let level = 1; level <= 6; level++) {
      const { tree, text } = parseOk(`${"#".repeat(level)} Title ${level}\n`)
      expect(text(findNode(tree, "marker"))).toBe("#".repeat(level))
      expect(text(findNode(tree, "heading"))).toContain(`Title ${level}`)
    }
  })

  it("treats seven hashes as text", () => {
    const { tree } = parseOk("####### Not a heading\n")
    expect(findNode(tree, "heading")).toBeNull()
    expect(findNode(tree, "paragraph")).not.toBeNull()
  })

  it("requires content after the marker separator", () => {
    const { tree } = parseOk("#\n")
    expect(findNode(tree, "heading")).toBeNull()
  })

  it("requires the marker at column zero", () => {
    // CARVE-P2-001: Carve drops CommonMark's 0-3 space indent.
    const { tree } = parseOk("   # Indented\n")
    expect(findNode(tree, "heading")).toBeNull()
  })

  it("treats every space in the separator run as separator", () => {
    // CARVE-P2-002: `##<SP><SP>h` is the heading `h`, not `<SP>h`.
    const { tree } = parseOk("##   Spaced\n")
    expect(findNode(tree, "content")!.from).toBe(5)
  })
})

describe("thematic breaks", () => {
  it("recognises ---, *** and ___", () => {
    for (const marker of ["---", "***", "___"]) {
      const { tree } = parseOk(`${marker}\n`)
      expect(findNode(tree, "thematic_break"), marker).not.toBeNull()
    }
  })

  it("requires at least three glyphs", () => {
    const { tree } = parseOk("--\n")
    expect(findNode(tree, "thematic_break")).toBeNull()
  })

  it("requires the line to hold nothing else", () => {
    const { tree } = parseOk("--- trailing\n")
    expect(findNode(tree, "thematic_break")).toBeNull()
  })
})

describe("frontmatter", () => {
  it("does not treat a later divider as another frontmatter opener", () => {
    const { tree } = parseOk("--- yaml\nkey: value\n---\n---\nbody\n")
    expect(findNodes(tree, "frontmatter")).toHaveLength(1)
    expect(findNodes(tree, "thematic_break")).toHaveLength(1)
  })

  it("does not classify a quote's divider using the document frontmatter", () => {
    const { tree } = parseOk("--- yaml\nkey: value\n---\n\n> ---\n> quote\n")
    expect(findNodes(tree, "frontmatter")).toHaveLength(1)
    expect(findNodes(tree, "thematic_break")).toHaveLength(1)
  })

  it("keeps the format token free of its whitespace prefix", () => {
    const { tree, text } = parseOk("--- yaml\nkey: value\n---\n")
    expect(text(findNode(tree, "language"))).toBe("yaml")
  })

  it("reads a typed opener as frontmatter", () => {
    const { tree, text } = parseOk("---yaml\ntitle: x\n---\n\nBody\n")
    expect(text(findNode(tree, "frontmatter"))).toBe("---yaml\ntitle: x\n---")
    expect(findNodes(tree, "frontmatter_marker")).toHaveLength(2)
  })

  it("measures the opener past a byte-order mark", () => {
    // Measuring from the line start found no dashes at all, and emitted a
    // marker covering nothing with the whole line read as a language name.
    const { tree, text } = parseOk("\uFEFF---\ntitle: x\n---\n\nBody\n")
    const markers = findNodes(tree, "frontmatter_marker")
    expect(markers).toHaveLength(2)
    expect(markers.map(text)).toEqual(["---", "---"])
    expect(findNode(tree, "language")).toBeNull()
  })

  it("reads a bare opener when the body is a mapping", () => {
    // CARVE-P2-030: the YAML shape test is the only shape rule.
    const { tree } = parseOk("---\ntitle: x\ntags: [a]\n---\n\nBody\n")
    expect(findNode(tree, "frontmatter")).not.toBeNull()
  })

  it("leaves a bare opener alone when the body is not a mapping", () => {
    const { tree } = parseOk("---\n[table]\n---\n\nBody\n")
    expect(findNode(tree, "frontmatter")).toBeNull()
  })

  it("leaves a bare opener with no closer as a thematic break", () => {
    const { tree } = parseOk("---\nSome text\n")
    expect(findNode(tree, "frontmatter")).toBeNull()
    expect(findNode(tree, "thematic_break")).not.toBeNull()
  })

  it("skips comment lines when testing the shape", () => {
    const { tree } = parseOk("---\n# a comment\ntitle: x\n---\n")
    expect(findNode(tree, "frontmatter")).not.toBeNull()
  })
})

describe("fenced code", () => {
  it("parses a fence with a language", () => {
    const { tree, text } = parseOk("```js\nconst a = 1\n```\n")
    expect(text(findNode(tree, "language"))).toBe("js")
    expect(text(findNode(tree, "code"))).toBe("\nconst a = 1\n")
    expect(text(findNode(tree, "code_block"))).toBe("```js\nconst a = 1\n```")
  })

  it("reads the header's title and label", () => {
    const { tree, text } = parseOk('```python "Header" [Label]\npass\n```\n')
    expect(text(findNode(tree, "language"))).toBe("python")
    expect(text(findNode(tree, "div_title"))).toBe("Header")
    expect(text(findNode(tree, "code_block_label"))).toBe("[Label]")
  })

  it("requires a closer of exactly the opener's width", () => {
    const { tree, text } = parseOk("````\ncode\n```\nstill code\n````\n")
    expect(text(findNode(tree, "code_block"))).toBe("````\ncode\n```\nstill code\n````")
  })

  it("parses a raw fence", () => {
    const { tree, text } = parseOk("```=html\n<b>x</b>\n```\n")
    expect(findNode(tree, "raw_block")).not.toBeNull()
    expect(text(findNode(tree, "language"))).toBe("html")
  })

  it("excludes whitespace after a raw format equals sign from its language node", () => {
    const { tree, text } = parseOk("```= html\n<b>raw</b>\n```\n")
    expect(text(findNode(tree, "language"))).toBe("html")
  })

  it("closes an unclosed fence with its container", () => {
    // CARVE-P0-014: a fence never reaches past the container that opened it,
    // so the block after the quote must not be swallowed.
    const { tree, text } = parseOk("> ```\n> x\n\nafter\n")
    const block = findNode(tree, "code_block")!
    const quote = findNode(tree, "block_quote")!
    // The continuous wrapper keeps coordinates and line breaks; its content
    // children describe the payload without the quote prefixes.
    expect(
      findNodes(tree, "content")
        .filter(node => node.parent?.name === "code")
        .map(text)
    ).toEqual(["x"])
    expect(block.to).toBeLessThanOrEqual(quote.to)
    const after = findNode(tree, "paragraph")!
    expect(text(after)).toBe("after")
    expect(after.parent!.name).toBe("document")
  })

  it("does not let a fence close on an outer container's fence", () => {
    const { tree, text } = parseOk("> ```\n> x\n```\n")
    expect(
      findNodes(tree, "content")
        .filter(node => node.parent?.name === "code")
        .map(text)
    ).toEqual(["x"])
    expect(findNode(tree, "code_block")!.to).toBeLessThanOrEqual(findNode(tree, "block_quote")!.to)
  })

  it("keeps a code body opaque to inline markup", () => {
    const { tree } = parseOk("```\n*not bold* /not em/\n```\n")
    expect(findNode(tree, "emphasis")).toBeNull()
    expect(findNode(tree, "strong")).toBeNull()
  })

  it("does not run an escape past the end of what it is scanning", () => {
    // An escaped pipe belongs to its cell. A trailing backslash in an
    // unfinished row has no character to escape and stays ordinary text.
    const { tree, text } = parseOk("|a \\| b |\n")
    expect(text(findNode(tree, "backslash_escape"))).toBe("\\|")
    const cell = findNodes(tree, "table_cell")[0]
    expect(text(cell)).toBe("|a \\| b ")
    expect(findNodes(tree, "table_cell")).toHaveLength(1)
    const trailing = parseOk("|a \\")
    expect(findNode(trailing.tree, "backslash_escape")).toBeNull()
  })

  it("does not name a language for a fence with none", () => {
    // `= ` with nothing after it names no format, and an empty token is not a
    // token.
    const { tree } = parseOk("```==\n")
    expect(findNode(tree, "raw_block")).not.toBeNull()
    expect(findNode(tree, "language")).toBeNull()
  })

  it("fences code with tildes too", () => {
    const { tree, text } = parseOk("~~~ python\nx = 1\n~~~\n")
    expect(text(findNode(tree, "language"))).toBe("python")
    expect(text(findNode(tree, "code"))).toBe("\nx = 1\n")
    expect(text(findNode(tree, "code_block_marker_end"))).toBe("~~~")
  })

  it("does not close a tilde fence on a backtick run", () => {
    const { tree, text } = parseOk("~~~\n```\n~~~\n")
    expect(text(findNode(tree, "code"))).toBe("\n```\n")
  })

  it("leaves strikethrough alone", () => {
    const { tree } = parseOk("~gone~\n")
    expect(findNode(tree, "strikethrough")).not.toBeNull()
    expect(findNode(tree, "code_block")).toBeNull()
  })
})

describe("comments", () => {
  it("parses a line comment", () => {
    const { tree, text } = parseOk("%% hidden\n\nVisible\n")
    expect(text(findNode(tree, "comment_line"))).toBe("%% hidden")
  })

  it("parses a fenced comment", () => {
    const { tree } = parseOk("%%%\nblock\ncomment\n%%%\n")
    expect(findNode(tree, "fenced_comment_block")).not.toBeNull()
  })

  it("parses a braced hidden comment inline", () => {
    const { tree, text } = parseOk("foo {% hidden %} baz\n")
    expect(text(findNode(tree, "braced_comment"))).toBe("{% hidden %}")
  })

  it("does not start a block on an indented comment", () => {
    const { tree } = parseOk("  %% indented\n")
    expect(findNode(tree, "comment_line")).toBeNull()
  })
})

describe("block quotes", () => {
  it("parses a multi-line quote", () => {
    const { tree, text } = parseOk("> one\n> two\n")
    expect(text(findNode(tree, "block_quote"))).toBe("> one\n> two")
    // The paragraph spans both lines, so it claims the second `>`. Emitting that
    // marker too would give the quote two overlapping children, which Lezer
    // forbids and the specification rules out; only the opener is a sibling.
    const markers = findNodes(tree, "block_quote_marker")
    expect(markers).toHaveLength(1)
    expect(text(markers[0])).toBe("> ")
    expect(findNodes(tree, "paragraph")).toHaveLength(1)
  })

  it("folds unmarked prose into the open quote", () => {
    // CARVE-P0-015: a lazy fold closes no container.
    const { tree, text } = parseOk("> one\nlazy\n")
    expect(text(findNode(tree, "block_quote"))).toBe("> one\nlazy")
  })

  it("closes at a blank line", () => {
    const { tree } = parseOk("> one\n\noutside\n")
    expect(findNode(tree, "block_quote")).not.toBeNull()
    expect(findNodes(tree, "paragraph")).toHaveLength(2)
  })

  it("nests", () => {
    const { tree } = parseOk("> outer\n> > inner\n")
    expect(findNodes(tree, "block_quote")).toHaveLength(2)
    expect(nodePathAt(tree, findNodes(tree, "block_quote")[1].from)).toContain("block_quote")
  })

  it("keeps blocks inside the quote", () => {
    const { tree } = parseOk("> - a\n> - b\n")
    expect(nodePathAt(tree, findNode(tree, "list_item")!.from)).toContain("block_quote")
  })

  it("attaches a flush-left block through a lone +", () => {
    // PART 9 §17: the `+` is the quote's punctuation, and the block it
    // introduces belongs to the quote even though nothing marks it as such.
    const { tree, text } = parseOk("> quoted\n+\nflush left\n")
    expect(text(findNode(tree, "list_continuation_marker"))).toBe("+")
    const attached = findNodes(tree, "paragraph")[1]
    expect(text(attached)).toBe("flush left")
    expect(attached.parent!.name).toBe("block_quote")
  })

  it("leaves a plus sign alone outside a container", () => {
    // A top-level `+` has nothing to attach to, so it stays prose.
    const { tree } = parseOk("just + text\n")
    expect(findNode(tree, "list_continuation_marker")).toBeNull()
    expect(findNode(tree, "paragraph")).not.toBeNull()
  })

  it("closes a container nested in a list item", () => {
    // The closer sits at the item's content column, not at column 0 — the
    // marker-line fence the upstream layout fixtures name.
    const { tree, text } = parseOk("- ::: note\n  body\n  :::\n")
    expect(text(findNode(tree, "div"))).toBe("::: note\n  body\n  :::")
    expect(text(findNodes(tree, "div_marker_end")[0])).toBe(":::")
    // The body must survive the nesting intact.
    expect(text(findNode(tree, "paragraph"))).toBe("body")
  })

  it("splits the quote's paragraphs on a bare marker line", () => {
    // `blockquote_line = '>', (newline | (space, inline_content, newline))`:
    // a `>` with nothing after it is a blank line inside the quote, not prose.
    const { tree, text } = parseOk("> one\n>\n> two\n")
    const paragraphs = findNodes(tree, "paragraph")
    expect(paragraphs.map(text)).toEqual(["one", "two"])
    expect(findNodes(tree, "block_quote")).toHaveLength(1)
  })

  it("keeps a quote's markers in document order", () => {
    // The marker on the third line comes after the paragraph on the second.
    // Emitting it early put two siblings out of order, which Lezer forbids.
    const { tree } = parseOk(">\n?\n>\n")
    expect(findNodes(tree, "block_quote_marker").map(n => n.from)).toEqual([0, 4])
  })

  it("does not stop a block on the empty line after a trailing newline", () => {
    // That line holds nothing, but its end is the end of the document, so a
    // container whose extent reached it ran a character past its own content.
    const { tree } = parseOk(":::\n. \n+\n`\n")
    const div = findNode(tree, "div")!
    const list = findNode(tree, "list")!
    expect(list.to).toBeLessThanOrEqual(div.to)
  })

  it("closes a container nested in a quote", () => {
    const { tree, text } = parseOk("> ::: n\n> x\n> :::\n")
    expect(text(findNode(tree, "div"))).toBe("::: n\n> x\n> :::")
    expect(text(findNode(tree, "paragraph"))).toBe("x")
    expect(findNodes(tree, "block_quote")).toHaveLength(1)
  })

  it("does not see an outer container's marker as a nested quote", () => {
    const { tree } = parseOk("> ::: a\n> - i\n> :::\n")
    expect(findNodes(tree, "block_quote")).toHaveLength(1)
    expect(findNodes(tree, "div")).toHaveLength(1)
    expect(findNodes(tree, "list")).toHaveLength(1)
  })

  it("keeps containers inside the quote", () => {
    const { tree } = parseOk("> ::: note\n> body\n> :::\n")
    expect(nodePathAt(tree, findNode(tree, "div")!.from)).toContain("block_quote")
  })
})

describe("colon containers", () => {
  it("parses a typed admonition with a title", () => {
    const { tree, text } = parseOk('::: note "Heads up"\nbody\n:::\n')
    expect(text(findNode(tree, "admonition_type"))).toBe("note")
    expect(text(findNode(tree, "div_title"))).toBe("Heads up")
    expect(text(findNode(tree, "div"))).toBe('::: note "Heads up"\nbody\n:::')
  })

  it("parses a plain div", () => {
    const { tree } = parseOk(":::\nbody\n:::\n")
    expect(findNode(tree, "admonition_type")).toBeNull()
    expect(findNode(tree, "div")).not.toBeNull()
  })

  it("requires a closer of exactly the opener's width", () => {
    const { tree, text } = parseOk(":::: outer\n::: inner\n:::\n::::\n")
    const divs = findNodes(tree, "div")
    expect(divs).toHaveLength(2)
    expect(text(divs[0])).toBe(":::: outer\n::: inner\n:::\n::::")
  })

  it("names the reserved sigils", () => {
    expect(findNode(parseOk("::: |\nline\n:::\n").tree, "line_block_marker")).not.toBeNull()
    expect(findNode(parseOk("::: >\nline\n:::\n").tree, "block_quote_fence_marker")).not.toBeNull()
    expect(findNode(parseOk("::: \\ \none\n:::\n").tree, "local_hard_break_marker")).not.toBeNull()
  })

  it("names a figure group", () => {
    const { tree } = parseOk("::: figure\n![one](a.png)\n::: \n^ The pair\n")
    expect(findNode(tree, "figure_group_marker")).not.toBeNull()
  })

  it("nests a container in a list item", () => {
    const { tree } = parseOk("- item\n  ::: note\n  body\n  :::\n")
    expect(nodePathAt(tree, findNode(tree, "div")!.from)).toContain("list_item")
  })

  it("runs to the end of the document when unclosed", () => {
    const { tree, text } = parseOk("::: note\nbody\n")
    expect(text(findNode(tree, "div"))).toBe("::: note\nbody")
    expect(findNode(tree, "div_marker_end")).toBeNull()
  })
})

describe("lists", () => {
  it("parses bullet items and their markers", () => {
    const { tree } = parseOk("- one\n- two\n")
    expect(findNodes(tree, "list_item")).toHaveLength(2)
    expect(findNodes(tree, "list_marker_dash")).toHaveLength(2)
    expect(findNodes(tree, "list")).toHaveLength(1)
  })

  it("recognises task checkboxes", () => {
    const { tree, text } = parseOk("- [ ] todo\n- [x] done\n")
    expect(text(findNodes(tree, "unchecked")[0])).toBe(" ")
    expect(text(findNodes(tree, "checked")[0])).toBe("x")
    expect(findNodes(tree, "list_marker_task")).toHaveLength(2)
  })

  it("does not treat the checkbox as marker width", () => {
    // CARVE-P0-008: the checkbox is content, so the item's content column is
    // the one after `- `.
    const { tree, text } = parseOk("- [ ] one\n  continued\n")
    expect(text(findNode(tree, "list_item"))).toBe("- [ ] one\n  continued")
  })

  it("keeps decimal and auto-numbered forms in separate lists", () => {
    const { tree } = parseOk("1. one\n1. two\n. auto\n")
    expect(findNodes(tree, "list")).toHaveLength(2)
    expect(findNodes(tree, "list_marker_decimal_period")).toHaveLength(2)
  })

  it("parses dialected alpha and roman markers", () => {
    const { tree, text } = parseOk("a. one\ni) two\n")
    expect(text(findNodes(tree, "list_marker_lower_alpha_period")[0])).toBe("a.")
    expect(text(findNodes(tree, "list_marker_lower_roman_paren")[0])).toBe("i)")
  })

  it("nests", () => {
    const { tree } = parseOk("- outer\n  - inner\n")
    const path = nodePathAt(tree, findNodes(tree, "list_item")[1].from)
    expect(path.filter(n => n === "list").length).toBe(2)
  })

  it("ends the item at a less-indented sibling", () => {
    const { tree, text } = parseOk("- one\n  more\n- two\n")
    const items = findNodes(tree, "list_item")
    expect(items).toHaveLength(2)
    expect(text(items[0])).toBe("- one\n  more")
  })

  it("continues the list across a blank line", () => {
    const { tree } = parseOk("- one\n\n- two\n")
    expect(findNodes(tree, "list")).toHaveLength(1)
    expect(findNodes(tree, "list_item")).toHaveLength(2)
  })

  it("ends the list when the next block is not an item", () => {
    const { tree } = parseOk("- one\n\n# Heading\n")
    expect(findNodes(tree, "list")).toHaveLength(1)
    expect(findNode(tree, "heading")).not.toBeNull()
  })

  it("holds a nested container", () => {
    const { tree } = parseOk("- item\n\n  ::: note\n  body\n  :::\n")
    expect(nodePathAt(tree, findNode(tree, "div")!.from)).toContain("list_item")
  })
})

describe("definition lists", () => {
  it("pairs a term with its descriptions", () => {
    const { tree, text } = parseOk(":: Carve\n: A markup language\n")
    expect(text(findNode(tree, "list_marker_definition"))).toBe("::")
    expect(text(findNode(tree, "term"))).toBe("Carve")
    expect(text(findNode(tree, "definition"))).toBe("A markup language")
    expect(findNode(tree, "definition_list")).not.toBeNull()
  })

  it("keeps a block inside an item's content column", () => {
    // PART 9 §17: a lone `+` at the item's marker column attaches the block
    // below it to the item, flush-left and unmarked.
    const { tree, text } = parseOk("- a\n+\n```sh\nx\n```\n")
    const item = findNodes(tree, "list_item")[0]
    expect(text(findNode(tree, "list_continuation_marker"))).toBe("+")
    const fence = findNode(tree, "code_block")!
    expect(text(fence)).toBe("```sh\nx\n```")
    expect(fence.from).toBeGreaterThanOrEqual(item.from)
    expect(fence.to).toBeLessThanOrEqual(item.to)
  })

  it("holds several descriptions for one term", () => {
    const { tree } = parseOk(":: Carve\n: first\n: second\n")
    expect(findNodes(tree, "definition")).toHaveLength(2)
    expect(findNodes(tree, "term")).toHaveLength(1)
  })

  it("reads a nested definition list's markers at its own column", () => {
    // `definitionList` measured its `::` from the line's first non-space, which
    // inside a quote is the quote's `>`. It then consumed nothing, and the block
    // loop re-entered it until the node buffer overflowed.
    const { tree, text } = parseOk(">> :: x\n")
    expect(text(findNode(tree, "term"))).toBe("x")
    expect(findNodes(tree, "definition_list")).toHaveLength(1)
  })
})

describe("tables", () => {
  it("reads a table nested in a container at the container's column", () => {
    // The row scan read the first non-space on the *physical* line, which
    // inside a quote is the quote's own `>`. The first row is taken whatever
    // it starts with, so it takes two rows before the mistake shows: the
    // second fails the check and becomes a table of its own.
    const { tree, text } = parseOk("> | a | b |\n> | c | d |\n")
    expect(findNodes(tree, "table")).toHaveLength(1)
    expect(findNodes(tree, "table_row").map(text)).toEqual(["| a | b |", "| c | d |"])
    expect(findNodes(tree, "table_cell")).toHaveLength(4)
  })

  it("reads attributes glued to a cell's marker run", () => {
    // PART 9 T10: an attribute block binds last and no whitespace may come
    // between it and what precedes it, so it is part of the run, not content.
    const { tree, text } = parseOk("|{.x} cell | d |\n")
    const attrs = findNode(tree, "table_cell_attributes")!
    expect(text(attrs)).toBe("{.x}")
    expect(text(findNodes(tree, "class_name")[0])).toBe(".x")
    // The attribute block IS the marker run here; there is no alignment left.
    expect(findNode(tree, "table_cell_alignment")).toBeNull()
  })

  it("keeps the alignment run that precedes cell attributes", () => {
    const { tree, text } = parseOk("|=>{.y} x | y |\n")
    expect(text(findNode(tree, "table_cell_alignment"))).toBe(">")
    expect(text(findNode(tree, "table_cell_attributes"))).toBe("{.y}")
  })

  it("treats a space before the brace as content, not attributes", () => {
    const { tree } = parseOk("| {.x} cell | d |\n")
    expect(findNode(tree, "table_cell_attributes")).toBeNull()
  })

  it("reads a continuation row as appending to the row above", () => {
    const { tree, text } = parseOk("| a | b |\n+ c | d |\n")
    expect(text(findNode(tree, "table_continuation_row"))).toBe("+ c | d |")
    expect(findNodes(tree, "table_row")).toHaveLength(1)
  })

  it("parses a header, rows and a caption", () => {
    const { tree, text } = parseOk("|= Item |= Qty |\n| Apple | 12 |\n^ Stock\n")
    // A table's caption belongs to the table, so folding it folds the caption.
    expect(text(findNode(tree, "table"))).toBe("|= Item |= Qty |\n| Apple | 12 |\n^ Stock")
    expect(findNodes(tree, "table_header")).toHaveLength(1)
    expect(findNodes(tree, "table_row")).toHaveLength(1)
    expect(findNodes(tree, "table_cell")).toHaveLength(4)
    expect(text(findNode(tree, "table_caption"))).toBe("^ Stock")
    expect(text(findNode(tree, "caption_marker"))).toBe("^ ")
  })

  it("reads the alignment run glued to the pipe", () => {
    const { tree, text } = parseOk("|=~ Item |\n| Apple |\n")
    expect(text(findNode(tree, "table_cell_alignment"))).toBe("~")
  })

  it("starts a new table after a non-pipe line", () => {
    const { tree } = parseOk("| a |\ntext\n| b |\n")
    expect(findNodes(tree, "table")).toHaveLength(2)
  })

  it("leaves `|=` as data when the space is missing", () => {
    // The cheatsheet: `|=a |` is a data cell whose text is `=a`.
    const { tree } = parseOk("|=a |\n")
    expect(findNode(tree, "table_header")).toBeNull()
    expect(findNode(tree, "table_row")).not.toBeNull()
  })
})

describe("captions", () => {
  it("requires a space after the caret", () => {
    const { tree } = parseOk("^not a caption\n")
    expect(findNode(tree, "caption")).toBeNull()
  })

  it("parses a caption for a figure", () => {
    const { tree, text } = parseOk("![Photo](a.png)\n^ A sunset\n")
    expect(text(findNode(tree, "caption"))).toBe("^ A sunset")
  })
})

describe("inline spans", () => {
  // source, span node, opening marker node, marker text
  const cases: [string, string, string, string][] = [
    ["/italic/", "emphasis", "emphasis_begin", "/"],
    ["*bold*", "strong", "strong_begin", "*"],
    ["/*both*/", "bold_italic", "bold_italic_begin", "/*"],
    ["_underline_", "underline", "underline_begin", "_"],
    ["~strike~", "strikethrough", "strikethrough_begin", "~"],
    ["=highlight=", "highlighted", "highlighted_begin", "="],
    ["{^sup^}", "superscript", "superscript_begin", "{^"],
    ["{,sub,}", "subscript", "subscript_begin", "{,"]
  ]

  for (const [source, node, beginNode, begin] of cases) {
    it(`parses ${source} as ${node}`, () => {
      const { tree, text } = parseOk(`${source}\n`)
      const found = findNode(tree, node)
      expect(found, source).not.toBeNull()
      expect(text(found)).toBe(source)
      expect(text(findNode(tree, beginNode))).toBe(begin)
      expect(findNode(tree, beginNode.replace(/_begin$/, "_end"))).not.toBeNull()
    })
  }

  it("nests spans", () => {
    const { tree } = parseOk("*bold with /em/ inside*\n")
    expect(nodePathAt(tree, findNode(tree, "emphasis")!.from)).toContain("strong")
  })

  it("reads braced spans in mid-word position", () => {
    // The braces delimit themselves, so `super{^script^}` is a superscript even
    // though a bare delimiter at the same spot would not open.
    const { tree, text } = parseOk("super{^script^} and sub{,script,}.\n")
    expect(text(findNode(tree, "superscript"))).toBe("{^script^}")
    expect(text(findNode(tree, "subscript"))).toBe("{,script,}")
  })

  it("reads smart dashes", () => {
    const { tree, text } = parseOk("an em dash --- and a range 10--20, or a - dash.\n")
    const em = findNodes(tree, "em_dash")
    const en = findNodes(tree, "en_dash")
    expect(text(em[0])).toBe("---")
    expect(text(en[0])).toBe("--")
    expect(text(en[1])).toBe("-")
  })

  it("leaves a hyphen inside a word alone", () => {
    const { tree } = parseOk("a well-known fact\n")
    expect(findNode(tree, "en_dash")).toBeNull()
  })

  it("leaves an empty pair as text", () => {
    const { tree } = parseOk("{++} text\n")
    expect(findNode(tree, "insert")).toBeNull()
  })

  it("requires bare delimiters to sit at word boundaries", () => {
    const { tree } = parseOk("intra_word_here\n")
    expect(findNode(tree, "underline")).toBeNull()
  })

  it("parses CriticMarkup", () => {
    const { tree } = parseOk("{+in+} {-out-} {#visible#} {% hidden %}\n")
    expect(findNode(tree, "insert")).not.toBeNull()
    expect(findNode(tree, "delete")).not.toBeNull()
    expect(findNode(tree, "editorial_comment")).not.toBeNull()
    expect(findNode(tree, "braced_comment")).not.toBeNull()
  })

  it("parses a substitution", () => {
    const { tree, text } = parseOk("{~old~>new~}\n")
    expect(text(findNode(tree, "substitution"))).toBe("{~old~>new~}")
  })

  it("treats {-} as a braced en dash", () => {
    const { tree } = parseOk("a {-} b\n")
    expect(findNode(tree, "en_dash")).not.toBeNull()
  })

  it("parses verbatim code and inline literals", () => {
    const { tree, text } = parseOk("`code` and !`/kaet/`\n")
    expect(text(findNode(tree, "verbatim"))).toBe("`code`")
    expect(text(findNode(tree, "inline_literal"))).toBe("!`/kaet/`")
    expect(findNode(tree, "emphasis")).toBeNull()
  })

  it("closes a verbatim run only on the same width", () => {
    const { tree, text } = parseOk("``a`b``\n")
    expect(text(findNode(tree, "verbatim"))).toBe("``a`b``")
  })

  it("skips longer backtick runs as whole runs when looking for a closer", () => {
    for (const [source, name] of [
      ["text `a`` tail``", "verbatim"],
      ["text !`a`` tail``", "inline_literal"],
      ["text $`a`` tail``", "math"]
    ]) {
      const { tree } = parseOk(`${source}\n`)
      expect(
        findNodes(tree, name).some(node => node.from === 5),
        source
      ).toBe(false)
    }
    for (const [source, name, expected] of [
      ["text `a`` tail`", "verbatim", "`a`` tail`"],
      ["text !`a`` tail`", "inline_literal", "!`a`` tail`"],
      ["text $`a`` tail`", "math", "$`a`` tail`"]
    ]) {
      const { tree, text } = parseOk(`${source}\n`)
      expect(text(findNode(tree, name))).toBe(expected)
    }
  })

  it("skips escaped closers and handles backslash parity", () => {
    for (const marker of ["*", "/", "_", "~", "="]) {
      const span = `${marker}a\\${marker} b${marker}`
      const name =
        marker === "*"
          ? "strong"
          : marker === "/"
            ? "emphasis"
            : marker === "_"
              ? "underline"
              : marker === "~"
                ? "strikethrough"
                : "highlighted"
      const { tree, text } = parseOk(`text ${span}\n`)
      expect(text(findNode(tree, name)), span).toBe(span)
      expect(text(findNode(tree, "backslash_escape")), span).toBe(`\\${marker}`)
    }
    const { tree, text } = parseOk("text *a\\\\* tail\n")
    expect(text(findNode(tree, "strong"))).toBe("*a\\\\*")
  })

  it("parses inline and display math", () => {
    expect(findNode(parseOk("a $`x` b\n").tree, "math")).not.toBeNull()
    expect(findNode(parseOk("a $$``x`` b\n").tree, "math")).not.toBeNull()
  })

  it("parses a raw inline passthrough", () => {
    const { tree, text } = parseOk("{=html}<b>x</b>{=html}\n")
    expect(text(findNode(tree, "raw_inline"))).toBe("{=html}<b>x</b>{=html}")
  })

  it("parses names, mentions and tags", () => {
    const { tree, text } = parseOk(":symbol:, @user, #tag\n")
    expect(text(findNode(tree, "symbol"))).toBe(":symbol:")
    expect(text(findNode(tree, "mention"))).toBe("@user")
    expect(text(findNode(tree, "tag"))).toBe("#tag")
  })

  it("does not read a heading as a tag", () => {
    const { tree } = parseOk("# Heading\n")
    expect(findNode(tree, "tag")).toBeNull()
  })

  it("parses an extension call", () => {
    const { tree, text } = parseOk(":youtube[dQw4w9WgXcQ]\n")
    expect(text(findNode(tree, "extension_inline"))).toBe(":youtube[dQw4w9WgXcQ]")
    expect(findNode(tree, "args")).not.toBeNull()
  })

  it("parses a hard break escape", () => {
    const { tree, text } = parseOk("one\\ \ntwo\n")
    expect(text(findNode(tree, "hard_line_break"))).toBe("\\ ")
  })

  it("parses a backslash escape", () => {
    const { tree, text } = parseOk("\\*not bold\\*\n")
    expect(text(findNode(tree, "backslash_escape"))).toBe("\\*")
    expect(findNode(tree, "strong")).toBeNull()
  })
})

describe("links", () => {
  it("parses an inline link", () => {
    const { tree, text } = parseOk("[text](https://example.com)\n")
    expect(text(findNode(tree, "inline_link"))).toBe("[text](https://example.com)")
    expect(text(findNode(tree, "link_text"))).toBe("text")
    expect(text(findNode(tree, "inline_link_destination"))).toBe("https://example.com")
  })

  it("parses a link title after the destination", () => {
    const { tree, text } = parseOk('[text](https://example.com "The title")\n')
    expect(text(findNode(tree, "inline_link_destination"))).toBe("https://example.com")
    expect(text(findNode(tree, "link_title"))).toBe("The title")
  })

  it("leaves a quote outside the link alone", () => {
    const { tree } = parseOk('Prose "quoted" [text](x)\n')
    expect(findNode(tree, "link_title")).toBeNull()
  })

  it("keeps a bare URL out of the span scanner", () => {
    const { tree } = parseOk("[a_b/c](x)\n")
    expect(findNode(tree, "underline")).toBeNull()
    expect(findNode(tree, "emphasis")).toBeNull()
  })

  it("parses reference links in all three forms", () => {
    expect(findNode(parseOk("[text][label]\n").tree, "full_reference_link")).not.toBeNull()
    expect(findNode(parseOk("[text][]\n").tree, "collapsed_reference_link")).not.toBeNull()
    expect(findNode(parseOk("[text]\n").tree, "collapsed_reference_link")).not.toBeNull()
  })

  it("parses images", () => {
    expect(findNode(parseOk("![alt](a.png)\n").tree, "inline_image")).not.toBeNull()
    expect(findNode(parseOk("![alt][ref]\n").tree, "full_reference_image")).not.toBeNull()
  })

  it("parses autolinks and cross-references", () => {
    const { tree } = parseOk("<https://example.com> and </#section-id>\n")
    expect(findNode(tree, "autolink")).not.toBeNull()
    expect(findNode(tree, "auto_text_link")).not.toBeNull()
  })

  it("parses a semantic span with attributes", () => {
    const { tree } = parseOk("[Tab]{kbd}\n")
    expect(findNode(tree, "span")).not.toBeNull()
    expect(findNode(tree, "inline_attribute")).not.toBeNull()
  })

  it("parses footnote references and inline notes", () => {
    expect(findNode(parseOk("Text[^1]\n").tree, "footnote_reference")).not.toBeNull()
    expect(findNode(parseOk("Text^[a note]\n").tree, "inline_note")).not.toBeNull()
  })
})

describe("definitions", () => {
  it("parses a link reference definition", () => {
    const { tree, text } = parseOk("[ref]: https://example.com\n")
    expect(text(findNode(tree, "link_label"))).toBe("ref")
    expect(text(findNode(tree, "link_destination"))).toBe("https://example.com")
    expect(findNode(tree, "link_reference_definition")).not.toBeNull()
  })

  it("parses a footnote definition with a multi-block body", () => {
    const { tree, text } = parseOk("[^f]: first\n\n    second\n")
    expect(text(findNode(tree, "reference_label"))).toBe("f")
    expect(findNodes(tree, "paragraph")).toHaveLength(2)
  })

  it("splits a footnote's label out of its delimiters", () => {
    // `[^`, the label and `]:` are three disjoint siblings, matching upstream.
    // One node covering all three would swallow the label.
    const { tree, text } = parseOk("[^f]: body\n")
    expect(text(findNode(tree, "footnote_marker_begin"))).toBe("[^")
    expect(text(findNode(tree, "reference_label"))).toBe("f")
    expect(text(findNode(tree, "footnote_marker_end"))).toBe("]:")
    expect(findNode(tree, "footnote_content")!.parent!.name).toBe("footnote")
  })

  it("keeps a footnote with an empty body sound", () => {
    const { tree } = parseOk("[^f]: \n")
    expect(findNode(tree, "footnote")).not.toBeNull()
    expect(findNode(tree, "footnote_content")).toBeNull()
  })

  it("parses an abbreviation definition", () => {
    const { tree, text } = parseOk("*[HTML]: HyperText Markup Language\n")
    expect(text(findNode(tree, "abbreviation_definition"))).toContain("HyperText Markup Language")
  })
})

describe("attributes", () => {
  it("gives an empty attribute no value node", () => {
    // `lang= fr` is an empty language attribute and a separate boolean. An
    // empty attribute has no characters to point at, and an empty token is not
    // a token, so the pair carries its key alone.
    const { tree, text } = parseOk("{#id lang= fr}\n")
    const pair = findNode(tree, "key_value")!
    expect(text(pair)).toBe("lang=")
    expect(text(findNode(tree, "key"))).toBe("lang")
    expect(findNode(tree, "value")).toBeNull()
    expect(text(findNode(tree, "boolean_attribute"))).toBe("fr")
  })

  it("parses a block attribute line", () => {
    const { tree, text } = parseOk("{#intro .lead lang=fr hidden}\n\n# Title\n")
    expect(text(findNode(tree, "identifier"))).toBe("#intro")
    expect(text(findNode(tree, "class_name"))).toBe(".lead")
    expect(text(findNode(tree, "key_value"))).toBe("lang=fr")
    expect(text(findNode(tree, "boolean_attribute"))).toBe("hidden")
    expect(findNode(tree, "block_attribute")).not.toBeNull()
  })

  it("parses an inline attribute after a span", () => {
    const { tree } = parseOk("Text{#id}\n")
    expect(findNode(tree, "inline_attribute")).not.toBeNull()
  })

  it("keeps quoted values together", () => {
    const { tree, text } = parseOk('{#fig caption="a } brace"}\n')
    expect(text(findNode(tree, "block_attribute"))).toBe('{#fig caption="a } brace"}')
  })

  it("distinguishes an id attribute from a CriticMarkup comment", () => {
    expect(findNode(parseOk("{#id}\n").tree, "block_attribute")).not.toBeNull()
    expect(findNode(parseOk("{#note#}\n").tree, "editorial_comment")).not.toBeNull()
  })
})

describe("robustness", () => {
  const hostile: [string, string][] = [
    ["lone bracket", "["],
    ["lone backtick", "`"],
    ["double backtick", "``"],
    ["open math", "$`"],
    ["open brace", "{"],
    ["open id", "{#"],
    ["open insert", "{+"],
    ["html comment", "<!--"],
    ["lone angle", "<"],
    ["close angle", "</"],
    ["tilde run", "~~~"],
    ["open div", ":::"],
    ["open definition", "::"],
    ["pipe", "|"],
    ["pipe with angle", "|>"],
    ["long star run", "*".repeat(200)],
    ["long underscore run", "_".repeat(200)],
    ["long dash run", "- ".repeat(100)],
    ["long quote run", "> ".repeat(50)],
    ["nested divs", ":::".repeat(30)],
    ["long bracket run", "[".repeat(60)],
    ["long fence", "```".repeat(40)],
    ["percent", "%"],
    ["caret", "^"],
    ["backslash", "\\"],
    ["long word", "a".repeat(10000)],
    ["alternating emphasis", "*a".repeat(2000)],
    ["many headings", Array.from({ length: 300 }, (_, i) => `## Heading ${i}`).join("\n")],
    ["long list", Array.from({ length: 200 }, (_, i) => `- item ${i}\n  continuation`).join("\n")],
    ["long code", `\`\`\`js\n${"const x = 1\n".repeat(500)}\`\`\``],
    ["crlf", "one\r\ntwo\r\n"],
    ["bom", "﻿# Title\n"]
  ]

  for (const [name, source] of hostile) {
    it(`stays sound on ${name}`, () => {
      const tree = parse(source)
      checkInvariants(source, tree)
      checkNoErrors(tree)
    })
  }

  it("does not blow the stack on deeply nested quotes", () => {
    const src = `${"> ".repeat(200)}deep\n`
    checkInvariants(src, parse(src))
  })

  it("keeps excessively nested quotes and list items within the call stack", () => {
    for (const marker of ["> ", "- "]) {
      const source = `${marker.repeat(3000)}deep\n`
      checkInvariants(source)
      checkNoErrors(parse(source))
    }
  })

  it("parses a large document in reasonable time", () => {
    const src = Array.from(
      { length: 4000 },
      (_, i) => `## Section ${i}\n\nSome *prose* with /emphasis/ and a [link](x).\n\n- one\n- two\n`
    ).join("\n")
    const start = Date.now()
    checkInvariants(src, parse(src))
    expect(Date.now() - start).toBeLessThan(20000)
  })

  it("is stable under repeated parses", () => {
    const src = "# Title\n\n- a\n- b\n\n> quote\n\n::: note\nbody\n:::\n"
    const first = parse(src).toString()
    for (let i = 0; i < 5; i++) expect(parse(src).toString()).toBe(first)
  })
})
