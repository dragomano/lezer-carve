import { TreeFragment } from "@lezer/common"
import { describe, expect, it } from "vitest"
import { parser } from "./helpers.js"

/**
 * Parse cost, measured rather than asserted about.
 *
 * The bounds here are deliberately loose — this is a regression guard, not a
 * benchmark to tune against. What it exists for is the shape of the curve: a
 * parser that is quadratic on ordinary prose still passes any absolute
 * threshold until the document gets big enough to be annoying.
 */

function time(source: string, runs: number, fragments: readonly TreeFragment[] = []): number {
  parser.parse(source, fragments) // warm the JIT
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint()
    parser.parse(source, fragments)
    // The fastest run, not the mean: this runs on shared machines, and a single
    // descheduled sample should not read as a complexity change.
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6)
  }
  return best
}

const PROSE =
  "A paragraph of ordinary prose that runs on for a while, with *bold*, /italic/ and a [link](https://example.com) in it.\n\n"

describe("parse cost", () => {
  it("does not repeatedly scan the same suffix for missing inline closers", () => {
    for (const opener of ["[", "{", "<", "*a "]) {
      const source = `text ${opener.repeat(16000)}`
      const ms = time(source, 3)
      expect(ms, `${JSON.stringify(opener)} took ${ms.toFixed(1)} ms`).toBeLessThan(120)
    }
  })

  it("makes an isolated edit cheaper than rebuilding all blocks", () => {
    const source = PROSE.repeat(4000),
      old = parser.parse(source)
    const pos = PROSE.length * 2000 + 10
    const changed = `${source.slice(0, pos)}x${source.slice(pos)}`
    const fragments = TreeFragment.applyChanges(
      TreeFragment.addTree(old),
      [{ fromA: pos, toA: pos, fromB: pos, toB: pos + 1 }],
      0
    )
    const full = time(changed, 8),
      incremental = time(changed, 8, fragments)
    expect(
      incremental,
      `incremental ${incremental.toFixed(1)} ms, full ${full.toFixed(1)} ms`
    ).toBeLessThan(full * 0.75)
  })

  it("parses a large document quickly", () => {
    const source = PROSE.repeat(4000) // ~470 KiB
    const ms = time(source, 5)
    // Generous by an order of magnitude; the current figure is ~7 ms.
    expect(ms, `${(source.length / 1024) | 0} KiB took ${ms.toFixed(1)} ms`).toBeLessThan(120)
  })

  it("scales roughly linearly, not quadratically", () => {
    const small = time(PROSE.repeat(1000), 5)
    const large = time(PROSE.repeat(4000), 5)
    const ratio = large / small
    // Four times the text. Linear is 4x, quadratic is 16x. Measured, the ratio
    // is about 2.5; the bound catches anything above roughly n^1.29 while
    // leaving room for a slower machine.
    expect(
      ratio,
      `4x the text took ${ratio.toFixed(1)}x the time (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms)`
    ).toBeLessThan(6)
  })

  it("does not scan past a construct it has already ruled out", () => {
    // The bug this guards is specific: `String.indexOf` has no end bound, so
    // looking for a delimiter that never comes scans the rest of the document.
    // It only shows on text with no links in it, which is why it survived.
    const plain = "A paragraph with no links and no braces of any kind in it.\n\n".repeat(2000)
    const ms = time(plain, 5)
    expect(
      ms,
      `${(plain.length / 1024) | 0} KiB of delimiter-free prose took ${ms.toFixed(1)} ms`
    ).toBeLessThan(120)
  })

  it("holds up on nested containers", () => {
    const nested =
      Array.from({ length: 60 }, (_, n) => `::: note ${n}\n`).join("") +
      Array.from({ length: 60 }, () => "- item\n  with a continuation line\n").join("") +
      Array.from({ length: 60 }, () => ":::\n\n").join("")
    const ms = time(nested, 5)
    expect(ms, `nested containers took ${ms.toFixed(1)} ms`).toBeLessThan(200)
  })
})
