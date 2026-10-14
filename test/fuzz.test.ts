import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkInvariants, checkNoErrors, nodeNames, parse } from "./helpers.js"

/**
 * A fuzz harness, run as a test so it runs in CI.
 *
 * The point is not coverage of Carve's syntax — the fixtures do that. The point
 * is the properties a parser must have for *any* input: the tree spans the
 * document, no child escapes its parent, no two siblings overlap, and the same
 * input always produces the same tree. A hand-written parser fails those on
 * inputs nobody thought to write, and a crash in an editor is a crash on a
 * document somebody was in the middle of typing.
 */

/** Every fixture on disk: the upstream corpus and this package's own documents. */
function fixtureSources(): string[] {
  const root = fileURLToPath(new URL("./", import.meta.url))
  const out: string[] = []
  for (const sub of ["corpus", "fixtures"]) {
    for (const name of readdirSync(root + sub)) {
      if (name.endsWith(".md") || name.endsWith(".crv")) {
        out.push(readFileSync(`${root + sub}/${name}`, "utf8"))
      }
    }
  }
  return out
}

/** A deterministic PRNG, so a failure is reproducible from the seed. */
function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

/**
 * Fragments chosen for the way they interact: openers with no closers, closers
 * with no openers, markers whose meaning depends on their column, and the
 * inline spans whose delimiters are also ordinary text.
 */
const FRAGMENTS = [
  "# ",
  "## ",
  "###### ",
  "####### ",
  "> ",
  ">> ",
  "- ",
  "* ",
  "+ ",
  "1. ",
  "1) ",
  "1)) ",
  "a. ",
  "a) ",
  "a: ",
  "i. ",
  "I) ",
  ". ",
  "::: ",
  "::: note",
  "::: figure",
  "::: |",
  "::: \\",
  "::: >",
  ":: ",
  ": ",
  "| ",
  "|= ",
  "|= A | B |",
  "|---",
  "|+ ",
  "```",
  "```js",
  "```=html",
  "~~~",
  "~~~ yaml",
  "%%%",
  "%%% TODO",
  "%% ",
  "{#id}",
  "{#id .cls key=val flag :lang}",
  "{: fr}",
  "^ ",
  "[^fn]: ",
  "[ref]: /u",
  "*[AB]: x",
  "[^",
  "[",
  "]",
  "()",
  "{",
  "}",
  "\\",
  "\\\\",
  "*",
  "/",
  "_",
  "~",
  "`",
  "==",
  "$",
  "!`x`",
  "{=html}",
  "@",
  "<x@y.z>",
  "<q>",
  "&amp;",
  "---",
  "...",
  "  ",
  "\t",
  "text ",
  "a",
  "1",
  "))",
  "![",
  "^[",
  "^[note]",
  "^(",
  "{(",
  "{~a~>b~}",
  "{+a+}",
  "{-a-}",
  "{#a#}",
  "{.x} ",
  ":x ",
  "(c) ",
  "==>",
  "-->",
  "<?pi?>",
  "%",
  "^$",
  "a\rb",
  " ",
  "﻿"
]

function document(rand: () => number, maxFragments: number): string {
  const lines: string[] = []
  const count = 1 + Math.floor(rand() * maxFragments)
  for (let i = 0; i < count; i++) {
    const parts = 1 + Math.floor(rand() * 4)
    let line = ""
    for (let j = 0; j < parts; j++) line += FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
    lines.push(line)
  }
  const ending = rand() < 0.2 ? "" : "\n"
  return lines.join("\n") + ending
}

describe("fuzz", () => {
  it("keeps tree bounds sound on arbitrary inline punctuation", () => {
    const chars = "ab01*_/~=!$[]{}()\\ .:@`|<>\t\n\r\uFEFF"
    for (let seed = 1; seed <= 10000; seed++) {
      const random = rng(seed + 0xabcdef)
      let source = "text "
      const count = Math.floor(random() * 200)
      for (let i = 0; i < count; i++) source += chars[Math.floor(random() * chars.length)]
      try {
        checkInvariants(source)
      } catch (error) {
        throw new Error(`seed ${seed}: ${JSON.stringify(source)}`, { cause: error })
      }
    }
  })

  it("produces a sound tree for any input it generates", () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 60000; seed++) {
      const source = document(rng(seed), 30)
      try {
        const tree = parse(source)
        checkInvariants(source, tree)
        checkNoErrors(tree)
        if (tree.length !== source.length) {
          throw new Error(`tree length ${tree.length} != ${source.length}`)
        }
      } catch (e) {
        failures.push(`seed ${seed}: ${(e as Error).message}\n${JSON.stringify(source)}`)
        if (failures.length > 6) break
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([])
  })

  it("parses the same input to the same tree every time", () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 20000; seed++) {
      const source = document(rng(seed + 900000), 16)
      try {
        const a = parse(source).toString()
        const b = parse(source).toString()
        if (a !== b) throw new Error("two parses disagree")
      } catch (e) {
        failures.push(`seed ${seed}: ${(e as Error).message}\n${JSON.stringify(source)}`)
        if (failures.length > 4) break
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([])
  })

  it("never throws on a truncated document", () => {
    // A document being typed is a prefix of a document that was valid. Every
    // prefix of every generated document has to parse.
    const failures: string[] = []
    for (let seed = 1; seed <= 1500; seed++) {
      const source = document(rng(seed + 700000), 20)
      for (let n = 0; n <= source.length; n += Math.max(1, Math.floor(source.length / 10))) {
        const prefix = source.slice(0, n)
        try {
          checkInvariants(prefix, parse(prefix))
        } catch (e) {
          failures.push(`seed ${seed} at ${n}: ${(e as Error).message}\n${JSON.stringify(prefix)}`)
          break
        }
      }
      if (failures.length > 4) break
    }
    expect(failures, failures.join("\n\n")).toEqual([])
  })

  it("treats a byte-order mark as encoding, not content", () => {
    const withBom = "﻿# Title\n\ntext\n"
    const without = "# Title\n\ntext\n"
    const bomNames = nodeNames(parse(withBom)).filter(n => n !== "document")
    const plainNames = nodeNames(parse(without)).filter(n => n !== "document")
    expect(bomNames).toEqual(plainNames)
  })
})

/**
 * The same properties, checked against documents that arrived the way documents
 * actually arrive: one character edited at a time.
 *
 * Building from fragments finds collisions between constructs. Editing real
 * fixtures finds the other half — a delimiter that stops matching, a marker's
 * column shifting, a block left unterminated mid-line — and it found two
 * defects the fragment generator never produced, in code no fixture exercised
 * in that state.
 */
describe("fuzz, by editing", () => {
  const EDIT_CHARS = " \n\r\t#>|-=+*~`[]{}\\^$:.,!?()_abZ019﻿"
  const bases = fixtureSources()

  function mutate(rand: () => number, base: string): string {
    let s = base
    const ops = 1 + Math.floor(rand() * 8)
    for (let i = 0; i < ops; i++) {
      if (!s.length) {
        s += EDIT_CHARS[Math.floor(rand() * EDIT_CHARS.length)]
        continue
      }
      const at = Math.floor(rand() * s.length)
      const roll = rand()
      const ch = EDIT_CHARS[Math.floor(rand() * EDIT_CHARS.length)]
      if (roll < 0.4) s = s.slice(0, at) + ch + s.slice(at)
      else if (roll < 0.8) s = s.slice(0, at) + s.slice(at + 1)
      else s = s.slice(0, at) + ch + s.slice(at + 1)
    }
    return s
  }

  it("parses a single-character edit of every fixture", () => {
    const failures: string[] = []
    for (let seed = 1; seed <= 20000; seed++) {
      const rand = rng(seed)
      const source = mutate(rand, bases[Math.floor(rand() * bases.length)])
      try {
        const tree = parse(source)
        checkInvariants(source, tree)
        checkNoErrors(tree)
      } catch (e) {
        failures.push(
          `seed ${seed}: ${(e as Error).message}\n${JSON.stringify(source.slice(0, 300))}`
        )
        if (failures.length > 4) break
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([])
  })
})
