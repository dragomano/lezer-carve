import { Source } from "lezer-carve"
import { describe, expect, it } from "vitest"
import { checkInvariants, findNode, findNodes, parse } from "./helpers.js"

function nodes(source: string, name: string): string[] {
  const tree = parse(source)
  checkInvariants(source, tree)
  return findNodes(tree, name).map(node => source.slice(node.from, node.to))
}

describe("parser review regressions", () => {
  it("reads nested spans from their own inline boundary", () => {
    expect(nodes("_*bold*_", "strong")).toEqual(["*bold*"])
    expect(nodes("/_under_/", "underline")).toEqual(["_under_"])
    expect(nodes("_*bold* unclosed", "strong")).toEqual([])
  })

  it("rechecks brackets reached inside an earlier lookahead's skipped code run", () => {
    expect(nodes("text [~`~[x]`", "collapsed_reference_link")).toEqual(["[x]"])
    expect(nodes("text [ [x]", "collapsed_reference_link")).toEqual(["[x]"])
  })

  it("keeps unpadded table cells and invalid marker runs as content", () => {
    expect(nodes("|a|b|", "table_cell")).toEqual(["|a", "|b"])
    expect(nodes("|a|b|", "content")).toEqual(["a", "b"])
    for (const text of ["=a", "^ x", "v x", "? x", "<> x", "word text", "*bold*"]) {
      expect(nodes(`|${text}|`, "table_cell_alignment"), text).toEqual([])
      expect(nodes(`|${text}|`, "content"), text).toContain(text)
    }
    expect(nodes("|*bold*|", "strong")).toEqual(["*bold*"])
  })

  it("keeps escaped pipes and matching backtick runs inside their table cell", () => {
    for (const body of ["a\\|b", "`a|b`", "``a`|b``", "!`a|b`", "$`a|b`"]) {
      const source = `| ${body} | c |`
      expect(nodes(source, "table_cell"), body).toEqual([`| ${body} `, "| c "])
    }
    expect(nodes("| a\\\\| b |", "table_cell")).toEqual(["| a\\\\", "| b "])
    expect(nodes("| `unclosed | b |", "table_cell")).toHaveLength(2)
  })

  it("reads quoted cell attributes without losing spaces or pipes in their values", () => {
    const source = '|=<{title="a | b" .x} *cell* | data |'
    expect(nodes(source, "table_cell_attributes")).toEqual(['{title="a | b" .x}'])
    expect(nodes(source, "table_cell_alignment")).toEqual(["<"])
    expect(nodes(source, "strong")).toEqual(["*cell*"])
    expect(nodes(source, "table_cell")).toHaveLength(2)
    expect(nodes("|{.x} < |", "content")).toContain("<")
    expect(nodes("| > |", "content")).toContain(">")
  })

  it("requires padding after a header or alignment marker run", () => {
    for (const source of ["|=|", "|=a |", "|<text|", "|~|", "|<{.x}|", "|{.x}=R|"]) {
      expect(nodes(source, "table_header"), source).toEqual([])
      expect(nodes(source, "table_cell_alignment"), source).toEqual([])
      expect(nodes(source, "table_cell_attributes"), source).toEqual([])
    }
    expect(nodes("|= A |=~ B |", "table_cell_alignment")).toEqual(["~"])
  })

  it("leaves HTML tags and malformed angle links as literal text", () => {
    for (const source of [
      "<b>x</b>",
      "<q>",
      "<a@b>",
      '<http://a/"q">',
      "<http://a/\\b>",
      "<http://a/<b>>",
      "<http://a/\u200b>",
      "<http://a/\u0080>",
      "</#two words>",
      "</#>"
    ]) {
      expect(nodes(source, "autolink"), source).toEqual([])
      expect(nodes(source, "auto_text_link"), source).toEqual([])
    }
    for (const source of [
      "<https://example.com>",
      "<a@b.com>",
      "<x:abc>",
      "<https://пример.рф/путь>"
    ]) {
      expect(nodes(source, "autolink"), source).toEqual([source])
    }
    expect(nodes("</#Привет-мир>", "auto_text_link")).toEqual(["</#Привет-мир>"])
    expect(nodes("</guide.crv#section>", "auto_text_link")).toEqual(["</guide.crv#section>"])
  })

  it("requires an exact frontmatter opener even when the body is a mapping", () => {
    for (const opener of ["----", "--- junk value", "---  yaml", "---\tyaml", "---!"]) {
      expect(nodes(`${opener}\nkey: value\n---`, "frontmatter"), opener).toEqual([])
    }
    expect(nodes("---yaml\nscalar\n--- \t", "frontmatter")).toHaveLength(1)
    expect(nodes("---\n  # comment\nkey: value\n---", "frontmatter")).toHaveLength(1)
  })

  it("recognises bare CR as a physical line ending", () => {
    const source = "# One\r# Two\r# Three"
    expect(nodes(source, "heading")).toEqual(["# One", "# Two", "# Three"])
    const view = new Source("a\rb\r\nc\n")
    expect(view.lineCount).toBe(4)
    expect(Array.from({ length: view.lineCount }, (_, line) => view.lineText(line))).toEqual([
      "a",
      "b",
      "c",
      ""
    ])
  })

  it("does not count a BOM as a fence or list content column", () => {
    const source = "\uFEFF```js\nx\n```\n# After"
    expect(nodes(source, "code_block_marker_end")).toEqual(["```"])
    expect(nodes(source, "heading")).toEqual(["# After"])
    const list = "\uFEFF- item\n  ```js\n  x\n  ```"
    expect(nodes(list, "code_block_marker_end")).toEqual(["```"])
  })

  it("recognises backslash line breaks with each supported line ending", () => {
    for (const separator of ["\n", "\r\n", "\r"]) {
      const source = `a\\${separator}b`
      expect(nodes(source, "hard_line_break"), JSON.stringify(source)).toEqual([`\\${separator}`])
    }
  })

  it("groups adjacent definition entries and shared terms into one list", () => {
    const source = ":: First\n:: Alias\n: Shared\n:: Second\n: Own"
    expect(nodes(source, "definition_list")).toEqual([source])
    expect(nodes(source, "list_item")).toEqual([":: First\n:: Alias\n: Shared", ":: Second\n: Own"])
    expect(nodes(source, "term")).toEqual(["First", "Alias", "Second"])
  })

  it("does not let a quoted inline attribute cross a physical line", () => {
    for (const separator of ["\n", "\r\n", "\r"]) {
      for (const prefix of ["", "\\"]) {
        const source = `text {title="first${prefix}${separator}second"}`
        expect(nodes(source, "inline_attribute"), JSON.stringify(source)).toEqual([])
      }
    }
  })

  it("keeps a div closer inside fenced code opaque", () => {
    const source = "::: note\n```js\n:::\n```\n:::"
    expect(nodes(source, "div")).toEqual([source])
    expect(nodes(source, "code")).toEqual(["\n:::\n"])
    expect(nodes(source, "code_block_marker_end")).toEqual(["```"])
  })

  it("pairs equal-width nested divs with their own closers", () => {
    const source = "::: outer\n::: inner\nbody\n:::\nouter tail\n:::"
    expect(nodes(source, "div")).toEqual([source, "::: inner\nbody\n:::"])
    expect(nodes(source, "div_marker_end")).toHaveLength(2)
  })

  it("accepts a longer closing code fence", () => {
    const source = "```js\ncode\n````\n# After"
    expect(nodes(source, "code_block_marker_end")).toEqual(["````"])
    expect(nodes(source, "heading")).toEqual(["# After"])
  })

  it("keeps an over-indented closing run inside a code payload", () => {
    const source = "- item\n  ```\n  code\n    ```\n  still code\n  ```"
    expect(nodes(source, "code")).toEqual(["\n  code\n    ```\n  still code\n"])
  })

  it("recognises raw formats on tilde fences and after optional padding", () => {
    for (const source of ["~~~=html\n<b>raw</b>\n~~~", "``` =html\n<b>raw</b>\n```"]) {
      expect(nodes(source, "raw_block"), source).toEqual([source])
      expect(nodes(source, "code_block"), source).toEqual([])
      expect(nodes(source, "language"), source).toEqual(["html"])
    }
  })

  it("closes comment fences despite indentation and a trailing label", () => {
    const source = "%%% note\ncomment\n  %%% end\n# After"
    expect(nodes(source, "fenced_comment_block")).toEqual(["%%% note\ncomment\n  %%% end"])
    expect(nodes(source, "heading")).toEqual(["# After"])
  })

  it("recognises single-quoted link titles with escaped quotes and parentheses", () => {
    const source = "[text](url 'a \\'quote\\' and ) title')"
    expect(nodes(source, "inline_link")).toEqual([source])
    expect(nodes(source, "link_title")).toEqual(["a \\'quote\\' and ) title"])
  })

  it("keeps quotes in link destinations separate from title delimiters", () => {
    const source = '[text](a"b "c")'
    expect(nodes(source, "inline_link_destination")).toEqual(['a"b'])
    expect(nodes(source, "link_title")).toEqual(["c"])
  })

  it("does not measure inline backticks after a continuation marker as a fence", () => {
    const source = "- item\n+\n`inline`\n# After"
    expect(nodes(source, "list_item")).toEqual(["- item\n+\n`inline`"])
    expect(nodes(source, "heading")).toEqual(["# After"])
  })

  it("keeps brackets inside verbatim link text opaque", () => {
    expect(nodes("[a `]` label](url)", "inline_link")).toEqual(["[a `]` label](url)"])
    expect(nodes("[a `]` label](url)", "verbatim")).toEqual(["`]`"])
  })

  it("keeps parentheses inside a quoted link title opaque", () => {
    const source = '[text](url "a ) title" )'
    expect(nodes(source, "inline_link")).toEqual([source])
    expect(nodes(source, "link_title")).toEqual(["a ) title"])
  })

  it("requires valid attributes before classifying a semantic span", () => {
    expect(nodes("[text]{unfinished", "span")).toEqual([])
    expect(nodes("[text]{unfinished", "collapsed_reference_link")).toEqual(["[text]"])
  })

  it("treats tabs in heading separators as separators rather than content", () => {
    expect(nodes("#\tTitle", "content")).toEqual(["Title"])
    expect(nodes("#\t", "heading")).toEqual([])
  })

  it("finds the code language after a tab separator", () => {
    expect(nodes("```\tjs\ncode\n```", "language")).toEqual(["js"])
  })
  for (const prefix of ["", "\uFEFF"]) {
    for (const format of ["yaml", "toml"]) {
      it(`recognises compact typed ${format} frontmatter after ${JSON.stringify(prefix)}`, () => {
        const source = `${prefix}---${format}\nscalar\n---\n`
        expect(nodes(source, "frontmatter")).toEqual([source.slice(prefix.length).trimEnd()])
        expect(nodes(source, "language")).toEqual([format])
      })
    }
  }

  it("ignores whitespace-only lines in a bare frontmatter shape test", () => {
    expect(nodes("---\n \t\nkey: value\n---", "frontmatter")).toHaveLength(1)
  })

  it("keeps a collapsed link's empty label brackets inside the link", () => {
    for (const prefix of ["", "!"]) {
      const source = `${prefix}[text][]`
      expect(
        nodes(source, prefix ? "collapsed_reference_image" : "collapsed_reference_link")
      ).toEqual([source])
    }
  })

  it("does not reopen an unmatched backtick run from its second character", () => {
    for (const prefix of ["", "!", "$"]) {
      expect(nodes(`text ${prefix}\`\`a\` tail`, "verbatim")).toEqual([])
    }
  })

  it("skips doubled symmetric closers as entire runs", () => {
    for (const [glyph, name] of [
      ["*", "strong"],
      ["/", "emphasis"],
      ["_", "underline"],
      ["~", "strikethrough"],
      ["=", "highlighted"]
    ]) {
      const span = `${glyph}a${glyph}${glyph} tail${glyph}`
      expect(nodes(`text ${span}`, name)).toEqual([span])
    }
  })

  it("keeps doubled openers and word-internal delimiters literal", () => {
    for (const [source, name] of [
      ["text **bold**", "strong"],
      ["text ~~gone~~", "strikethrough"],
      ["snake_/case/", "emphasis"],
      ["text *\nline*", "strong"]
    ]) {
      expect(nodes(source, name)).toEqual([])
    }
  })

  it("finds a complete braced closer after interior glyphs", () => {
    expect(nodes("text {^a^b^}", "superscript")).toEqual(["{^a^b^}"])
  })

  it("includes image prefixes in every image form", () => {
    for (const [source, name] of [
      ["![text](url)", "inline_image"],
      ["![text][label]", "full_reference_image"],
      ["![text]", "collapsed_reference_image"]
    ]) {
      expect(nodes(source, name)).toEqual([source])
    }
  })

  it("skips an escaped bold-italic closer", () => {
    expect(nodes("text /*a\\*/ tail*/", "bold_italic")).toEqual(["/*a\\*/ tail*/"])
  })

  it("keeps escaped quotes inside a single attribute value", () => {
    const source = 'text {title="a \\" b" hidden}'
    expect(nodes(source, "key_value")).toEqual(['title="a \\" b"'])
    expect(nodes(source, "boolean_attribute")).toEqual(["hidden"])
  })

  it("recognises language attributes", () => {
    expect(nodes("text {:en}", "language_attribute")).toEqual([":en"])
  })

  it("recognises separators at a quote's content column", () => {
    expect(nodes("> | a |\n> |---|---|\n> | b |", "table_separator")).toEqual(["|---|---|"])
  })

  it("parses the first cell after a table continuation marker", () => {
    expect(nodes("| a | b |\n+ continued | d |", "content")).toContain("continued")
  })

  it("stops a continued div at its closer rather than absorbing the next item", () => {
    const source = "- item\n+\n::: note\nbody\n:::\n- next\n"
    expect(nodes(source, "list_item")).toEqual(["- item\n+\n::: note\nbody\n:::", "- next"])
  })

  it("does not close an indented fence at a shallower column", () => {
    const source = "::: note\n  ```\n  code\n```\n  still code\n  ```\n:::"
    expect(nodes(source, "code_block_marker_end")).toHaveLength(1)
    const tree = parse(source),
      closer = findNode(tree, "code_block_marker_end")!
    expect(closer.from).toBe(source.lastIndexOf("```"))
  })

  it("treats a BOM-only first line as blank", () => {
    expect(new Source("\uFEFF\n").isBlank(0)).toBe(true)
  })

  it("starts a new list when its bullet or decimal delimiter changes", () => {
    for (const source of ["- one\n* two", "1. one\n2) two"]) {
      expect(nodes(source, "list")).toHaveLength(2)
    }
  })

  it("keeps indented footnote continuations inside a quote's footnote", () => {
    const source = "> [^f]: first\n>   second"
    expect(nodes(source, "footnote")).toEqual(["[^f]: first\n>   second"])
  })

  it("keeps quoted list continuations inside their item", () => {
    const source = "> - first\n>   second"
    expect(nodes(source, "list_item")).toEqual(["- first\n>   second"])
  })

  it("keeps reference links at an item start separate from task checkboxes", () => {
    expect(nodes("- [reference] text", "list_marker_task")).toEqual([])
    expect(nodes("- [reference] text", "collapsed_reference_link")).toEqual(["[reference]"])
  })
})
