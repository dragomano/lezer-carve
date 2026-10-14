import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildNodeSet, carveNodeSet, NODE_SPEC } from "lezer-carve"
import { describe, expect, it } from "vitest"

/**
 * `test/data/node-types.json` is `markup-carve/tree-sitter-carve`'s list of
 * named node types. It is not checked in; the test skips when it is absent so a
 * fresh clone still runs green, and speaks up when it is present, which is what
 * catches a node name drifting away from the ecosystem.
 *
 *   curl -o test/data/node-types.json \
 *     https://raw.githubusercontent.com/markup-carve/tree-sitter-carve/main/src/node-types.json
 */
const upstream = fileURLToPath(new URL("./data/node-types.json", import.meta.url))
const hasUpstream = existsSync(upstream)

/**
 * Names in upstream's node list that a Carve parser does not produce, and why.
 *
 * The node list is a grammar artifact as much as a language model: tree-sitter
 * needs nodes the language does not mean, and bridges carry wrappers Carve
 * itself has no spelling for. Keeping each omission here, with its reason, is
 * what stops the vocabulary drifting in either direction — an unexplained
 * addition is as much a bug as a missing name.
 */
const NOT_PRODUCED = new Map<string, string>([
  // The external scanner needs a node to hang the delimiter it just consumed.
  ["literal_marker", "tree-sitter's inline-literal delimiter artifact"],
  ["math_marker", "tree-sitter's math delimiter artifact"],
  ["language_marker", "tree-sitter's language-tag delimiter artifact"],
  ["fixme", "tree-sitter's fixme-delimiter artifact"],
  // Bridge-only wrappers. ast-schema.json: sectioning is implicit in heading
  // level, "so a parser does not produce it".
  ["section", "bridge-only wrapper; Carve has no section spelling"],
  ["section_content", "bridge-only wrapper; Carve has no section spelling"],
  ["image_description", "bridge-only wrapper"],
  // Not nodes of their own: a `:::` container's type name and a `%%%` fence's
  // info string respectively.
  ["note", "a ::: container's type name, which is div_title's text"],
  ["todo", "a %%% fence's info string, which is comment_fence_info's text"],
  // Absent from resources/ast-schema.json, so not part of the language model.
  ["callout_list", "absent from ast-schema.json"],
  ["callout_list_item", "absent from ast-schema.json"],
  ["abbreviation_expansion", "absent from ast-schema.json"],
  ["link_reference_attributes", "absent from ast-schema.json"],
  ["trailing_comment", "a carve-version stamp; still an ordinary comment line"],
  // File inclusion is a Tier-2 extension; resources/ast-schema.json has no
  // definition for it, so a Carve 0.1 parser has nothing to produce.
  ["include_directive", "Tier-2 extension, absent from ast-schema.json"],
  ["include_open", "Tier-2 extension, absent from ast-schema.json"],
  ["include_path", "Tier-2 extension, absent from ast-schema.json"],
  ["include_section", "Tier-2 extension, absent from ast-schema.json"],
  ["include_option", "Tier-2 extension, absent from ast-schema.json"],
  ["include_option_name", "Tier-2 extension, absent from ast-schema.json"],
  ["include_option_separator", "Tier-2 extension, absent from ast-schema.json"],
  ["include_option_value", "Tier-2 extension, absent from ast-schema.json"],
  ["include_extra", "Tier-2 extension, absent from ast-schema.json"],
  ["include_close", "Tier-2 extension, absent from ast-schema.json"],
  ["invalid_metadata", "absent from ast-schema.json"]
])

/**
 * Names this parser adds, and why. Everything else matches
 * `tree-sitter-carve`'s node list exactly.
 */
const ADDED = new Map<string, string>([
  ["link_mark", "link, inline-note and citation punctuation, which upstream leaves anonymous"],
  ["class_name", "the `.foo` attribute item, which upstream's node list leaves anonymous"]
])

/**
 * Read here, at module scope, rather than inside the describe below. vitest
 * evaluates a describe body while collecting, before skipIf has a chance to
 * act, so a read inside it throws ENOENT on a fresh clone instead of skipping
 * -- which is what it did. layout.test.ts reads the same way for the same
 * reason.
 */
const types: { type: string; named: boolean }[] = hasUpstream
  ? JSON.parse(readFileSync(upstream, "utf8"))
  : []

describe.skipIf(!hasUpstream)("node vocabulary", () => {
  const upstreamNames = new Set(types.filter(t => t.named).map(t => t.type))
  const ourNames = new Set(NODE_SPEC.map(([name]) => name))

  it("accounts for every upstream name, implemented or explained", () => {
    const missing = [...upstreamNames].filter(
      name => !ourNames.has(name) && !NOT_PRODUCED.has(name)
    )
    expect(missing, `missing from NODE_SPEC: ${missing.join(", ")}`).toEqual([])
  })

  it("has no name the ecosystem does not, except the documented additions", () => {
    const extra = [...ourNames].filter(name => !upstreamNames.has(name))
    expect(new Set(extra)).toEqual(new Set(ADDED.keys()))
  })

  it("gives every omission and addition a documented reason", () => {
    for (const [name, reason] of new Map([...NOT_PRODUCED, ...ADDED])) {
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10)
      expect(ourNames.has(name) || NOT_PRODUCED.has(name), `${name} is neither`).toBe(true)
      // A name cannot be both an omission and something we declare.
      expect(NOT_PRODUCED.has(name) && ADDED.has(name), `${name} is both`).toBe(false)
    }
  })

  it("drops an omission once the name is declared", () => {
    // Otherwise the map rots: a node implemented later stays listed as absent
    // and the vocabulary test keeps passing over the corpse.
    const stale = [...NOT_PRODUCED.keys()].filter(name => ourNames.has(name))
    expect(stale, `now implemented, remove from NOT_PRODUCED: ${stale.join(", ")}`).toEqual([])
  })
})

describe("node set", () => {
  it("has a type for every name in the specification", () => {
    const types = carveNodeSet.types
    expect(types).toHaveLength(NODE_SPEC.length)
    NODE_SPEC.forEach(([name], id) => {
      expect(types[id].name, `id ${id} should be ${name}`).toBe(name)
      expect(types[id].id).toBe(id)
    })
  })

  it("marks exactly the top-level nodes as top", () => {
    const top = carveNodeSet.types.filter(t => t.isTop).map(t => t.name)
    expect(top).toEqual(["document"])
  })

  it("gives the root node id 0, which the parser relies on", () => {
    expect(carveNodeSet.types[0].name).toBe("document")
    expect(carveNodeSet.types[0].isTop).toBe(true)
  })

  it("builds identically on every call", () => {
    // The parser caches a configured node set, so two builds must agree.
    const again = buildNodeSet()
      .types.map(t => `${t.id}:${t.name}`)
      .join(",")
    const third = buildNodeSet()
      .types.map(t => `${t.id}:${t.name}`)
      .join(",")
    expect(again).toBe(third)
  })
})
