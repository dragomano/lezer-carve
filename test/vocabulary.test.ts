import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { NODE_SPEC, parser } from "lezer-carve"
import { describe, expect, it } from "vitest"
import { nodeNames, parse } from "./helpers.js"

/**
 * Every node type this parser declares has to be reachable from some document
 * the tests carry.
 *
 * `terms.ts` is the one place where a name can be added without anybody
 * noticing: the node set grows, `names.test.ts` still passes because upstream
 * lists the name too, and highlighting gains an entry for a node no parse ever
 * produces. That is how this file accumulated a dozen types that existed only
 * in the vocabulary.
 *
 * The fix is to make the vocabulary testable: a name is either emitted by a
 * fixture, or listed below with the reason it is not yet.
 */

/** Fixtures that together are meant to exercise the whole vocabulary. */
function corpusSources(): string[] {
  const dir = fileURLToPath(new URL("./", import.meta.url))
  const sources: string[] = []
  for (const sub of ["corpus", "fixtures"]) {
    for (const name of readdirSync(fileURLToPath(new URL(sub, import.meta.url)))) {
      if (name.endsWith(".md") || name.endsWith(".crv")) {
        sources.push(readFileSync(`${dir + sub}/${name}`, "utf8"))
      }
    }
  }
  return sources
}

/**
 * Constructs no fixture covers, with what would close the gap. Keeping this
 * short is the point: an entry here is a debt with a name on it.
 */
const NOT_YET_PRODUCED = new Map<string, string>([
  ["comment", "no fixture uses a bare %% line with no fence around it"],
  ["braced_comment", "fixtures only reach {#..#} through editorial_comment"],
  ["language_attribute", "no fixture writes a {: tag} language attribute"]
])

describe("node vocabulary reachability", () => {
  const produced = new Set<string>()
  for (const source of corpusSources()) {
    for (const name of nodeNames(parse(source))) produced.add(name)
  }
  const citationSource = readFileSync(new URL("./fixtures/citations.crv", import.meta.url), "utf8")
  for (const name of nodeNames(
    parser.configure({ extensions: ["citations"] }).parse(citationSource)
  ))
    produced.add(name)

  it("emits every declared type from some fixture, or has a reason it does not", () => {
    const unreachable = NODE_SPEC.map(([name]) => name).filter(
      name => !produced.has(name) && !NOT_YET_PRODUCED.has(name)
    )
    expect(
      unreachable,
      `declared but never produced, and not listed in NOT_YET_PRODUCED: ${unreachable.join(", ")}`
    ).toEqual([])
  })

  it("gives every deferred type a reason", () => {
    for (const [name, reason] of NOT_YET_PRODUCED) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10)
      expect(
        NODE_SPEC.some(([n]) => n === name),
        `${name} is not declared`
      ).toBe(true)
    }
  })

  it("keeps the deferral list honest", () => {
    // A type that a new fixture now covers must leave the list, or it rots.
    const stale = [...NOT_YET_PRODUCED.keys()].filter(name => produced.has(name))
    expect(stale, `now produced, remove from NOT_YET_PRODUCED: ${stale.join(", ")}`).toEqual([])
  })

  it("actually exercises a useful share of the vocabulary", () => {
    // A guard against the fixtures quietly emptying out: if most types were
    // deferred, "every declared type is produced" would pass while testing
    // almost nothing.
    const declared = NODE_SPEC.length
    const covered = declared - NOT_YET_PRODUCED.size
    expect(covered / declared, "fixtures cover too little of the vocabulary").toBeGreaterThan(0.8)
  })
})
