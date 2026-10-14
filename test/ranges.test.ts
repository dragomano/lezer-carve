import { type Input, parseMixed } from "@lezer/common"
import { parser } from "lezer-carve"
import { describe, expect, it } from "vitest"
import { checkInvariants, findNode, findNodes } from "./helpers.js"

describe("parse ranges", () => {
  it("reads only the requested range and returns a tree relative to its start", () => {
    const doc = "# Outside\ninside\n# Tail"
    const from = doc.indexOf("inside"),
      to = from + "inside".length
    const reads: { from: number; to: number }[] = []
    const input: Input = {
      length: doc.length,
      lineChunks: false,
      chunk(pos) {
        return doc.slice(pos)
      },
      read(start, end) {
        expect(start).toBeGreaterThanOrEqual(from)
        expect(end).toBeLessThanOrEqual(to)
        reads.push({ from: start, to: end })
        return doc.slice(start, end)
      }
    }
    const partial = parser.startParse(input, [], [{ from, to }])
    expect(partial.parsedPos).toBe(from)
    let tree = partial.advance()
    while (!tree) tree = partial.advance()
    expect(partial.parsedPos).toBe(to)
    expect(reads).toEqual([{ from, to }])
    checkInvariants("inside", tree)
    expect(findNodes(tree, "heading")).toEqual([])
    expect(findNode(tree, "paragraph")).toMatchObject({ from: 0, to: 6 })
  })

  it("preserves positions across excluded gaps between lines", () => {
    const doc = "outside\n# One\n# Excluded\n# Two\noutside"
    const from = doc.indexOf("# One"),
      next = doc.indexOf("# Two")
    const to = next + "# Two".length
    const tree = parser.parse(
      doc,
      [],
      [
        { from, to: from + "# One\n".length },
        { from: next, to }
      ]
    )
    checkInvariants(doc.slice(from, to), tree)
    expect(findNodes(tree, "heading").map(node => ({ from: node.from, to: node.to }))).toEqual([
      { from: 0, to: "# One".length },
      { from: next - from, to: to - from }
    ])
  })

  it("maps both sides of a range boundary without including the gap", () => {
    const doc = "/one/EXCLUDED*two*"
    const next = doc.indexOf("*two*")
    const tree = parser.parse(
      doc,
      [],
      [
        { from: 0, to: 5 },
        { from: next, to: doc.length }
      ]
    )
    checkInvariants(doc, tree)
    expect(findNode(tree, "emphasis")).toMatchObject({ from: 0, to: 5 })
    expect(findNode(tree, "strong")).toMatchObject({ from: next, to: doc.length })
  })

  it("parses a construct that continues across ranges", () => {
    const doc = "outside *EXCLUDEDbold* outside"
    const from = doc.indexOf("*"),
      next = doc.indexOf("bold"),
      to = next + "bold*".length
    const tree = parser.parse(
      doc,
      [],
      [
        { from, to: from + 1 },
        { from: next, to }
      ]
    )
    checkInvariants(doc.slice(from, to), tree)
    expect(findNode(tree, "strong")).toMatchObject({ from: 0, to: to - from })
    expect(findNode(tree, "strong_begin")).toMatchObject({ from: 0, to: 1 })
    expect(findNode(tree, "strong_end")).toMatchObject({ from: to - from - 1, to: to - from })
  })

  it("passes the original input and ranges to wrappers", () => {
    const doc = "outside\ninside\noutside"
    const ranges = [{ from: 8, to: 14 }]
    let called = false
    const wrapped = parser.configure({
      wrap(inner, input, _fragments, received) {
        called = true
        expect(input.length).toBe(doc.length)
        expect(received).toEqual(ranges)
        return inner
      }
    })
    expect(wrapped.parse(doc, [], ranges).toString()).toBe("document(paragraph(content))")
    expect(called).toBe(true)
  })

  it("can be used as a mixed parser's nested language", () => {
    const doc = "# Outside\n\n```carve\n# Inside\n```"
    const host = parser.configure({
      wrap: parseMixed(ref => (ref.name === "code" ? { parser } : null))
    })
    const tree = host.parse(doc)
    const node = tree.resolveInner(doc.indexOf("Inside"), 1).parent!
    expect(node.name).toBe("heading")
    expect(node.from).toBe(doc.indexOf("# Inside"))
    expect(node.to).toBe(doc.indexOf("Inside") + "Inside".length)
  })

  it("supports empty and adjacent ranges", () => {
    expect(parser.parse("# Outside", [], []).length).toBe(0)
    const empty = parser.startParse("outside", [], [{ from: 3, to: 3 }])
    expect(empty.parsedPos).toBe(3)
    expect(empty.advance()!.length).toBe(0)
    const doc = "# Heading"
    const tree = parser.parse(
      doc,
      [],
      [
        { from: 0, to: 2 },
        { from: 2, to: doc.length }
      ]
    )
    expect(tree.toString()).toBe(parser.parse(doc).toString())
    checkInvariants(doc, tree)
  })

  it("maps arbitrary range boundaries like a parse of their concatenated text", () => {
    const doc = "# Heading\n\ntext /*a\\*/ tail*/ [link][]\n\n- item\n\n```js\nlet x = 1\n```"
    let seed = 0x1234abcd
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x100000000
    }
    for (let run = 0; run < 250; run++) {
      const ranges: { from: number; to: number }[] = []
      for (let from = Math.floor(random() * 5); from < doc.length; ) {
        const to = Math.min(doc.length, from + 1 + Math.floor(random() * 12))
        ranges.push({ from, to })
        from = to + Math.floor(random() * 8)
      }
      const selected = ranges.map(range => doc.slice(range.from, range.to)).join("")
      const expected: [string, number, number][] = []
      const map = (pos: number, side: -1 | 1) => {
        let offset = 0
        for (const range of ranges) {
          const end = offset + range.to - range.from
          if (pos < end || (pos === end && side === -1))
            return range.from - ranges[0].from + pos - offset
          offset = end
        }
        return ranges[ranges.length - 1].to - ranges[0].from
      }
      parser
        .parse(selected)
        .cursor()
        .iterate(node => {
          if (node.name !== "document")
            expected.push([node.name, map(node.from, 1), map(node.to, -1)])
        })
      const actual = parser.parse(doc, [], ranges),
        got: [string, number, number][] = []
      actual.cursor().iterate(node => {
        if (node.name !== "document") got.push([node.name, node.from, node.to])
      })
      checkInvariants(doc.slice(ranges[0].from, ranges[ranges.length - 1].to), actual)
      expect(got, JSON.stringify(ranges)).toEqual(expected)
    }
  })
})
