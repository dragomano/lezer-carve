# lezer-carve

Incremental parser for [Carve](https://markup-carve.github.io/carve), producing Lezer syntax
trees. Carve uses `*bold*`, `/italic/`, `. ` auto-numbered lists and `:::`
containers; its syntax differs from Markdown.

```bash
npm install lezer-carve
```

```js
import {parser} from "lezer-carve"

let tree = parser.parse("# Title\n\nA *bold* claim.\n")
```

For highlighting, folding, commands and completion, see
[`codemirror-carve`](https://npmx.dev/package/codemirror-carve).

## Parsing and configuration

`parser` is the default `CarveParser` instance. It implements Lezer's `Parser`
API, including `Input`, parse wrappers and selected ranges:

```js
const text = "# Outside\ninside"
const tree = parser.parse(text, [], [{from: 10, to: 16}])
// Only "inside" is parsed; tree positions are relative to offset 10.
```

Pass updated `TreeFragment` objects as the second argument to reuse unchanged
document blocks. Use `TreeFragment.addTree(previousTree)` followed by
`TreeFragment.applyChanges(fragments, changes)` when text changes. Blocks are
reparsed when their contents or boundary lookahead change; edits inside a large
container currently reparse that whole container.

`startParse()` is lazy, and each `advance()` processes one document block.
`stopAt()` stops at a complete block boundary. Changed input is still read
and indexed once per parse. Disjoint ranges retain offsets across excluded
gaps and currently use a full parse without fragment reuse.

`parser.configure(options)` returns a configured parser:

| Option | Purpose |
|---|---|
| `props` | Add Lezer node properties. |
| `wrap` | Add a parse wrapper or array of wrappers, such as `parseMixed`. |
| `extensions` | Replace the optional syntax set. `raw` enables `{=html}...{=html}` inline passthrough and is enabled by default. `citations` enables bibliography syntax and is off by default. `[]` disables both. |

Core syntax needs no extension entry.
Extremely deep container nesting falls back to paragraph content after 256
recursive container levels, keeping incomplete or hostile documents parseable.
Node names follow the `tree-sitter-carve` vocabulary; omissions and deferred
types are documented in [names.test.ts](test/names.test.ts) and
[vocabulary.test.ts](test/vocabulary.test.ts).

## Citations

Enable the optional [citations syntax](https://markup-carve.github.io/carve/extensions)
explicitly; include `raw` to keep the default inline passthrough:

```js
const withCitations = parser.configure({extensions: ["raw", "citations"]})
const tree = withCitations.parse(`See [@smith2020, p. 4; -@jones2019].

[@smith2020]: {author="Smith" year="2020"} Smith. *A Study*.
[@jones2019]: Jones. *Notes*.
`)
```

Groups produce `citation_group` nodes with `citation_label` children covering
the keys without `@`. Prefixes and locators contain parsed inline content.
An immediate `+` after `[` marks an integral group; `-@key` suppresses the author.
Items are separated by semicolons. Definitions produce `citation_definition`
with a key, optional `inline_attribute` metadata and a single-line
`citation_entry` containing inlines.

Links, reference links and spans with attributes take precedence over citations.
Bare `@mentions` remain mentions, and `@`-first reference labels are reserved
even when citations are disabled. Syntax parsing does not resolve keys, number
citations or render a bibliography; unresolved keys retain their source ranges.

## Visual parser example

The interactive guide in [`example/`](example/README.md) explains parsing through
a live syntax-tree diagram, linked source ranges, block-by-block stepping and
an incremental-reuse flowchart. All trees and reuse counts come from this
package's actual parser; no CodeMirror editor package is required.

From this package's root:

```bash
npm install --prefix example
npm run example
```

The example loads `src/index.ts` directly, so no package build or publication is
needed. Its dependencies and build output stay separate from the npm package.

## Development

From the package directory:

```bash
npm install
npm run check
npm test
npm run typecheck
npm run build
```

Type checking emits no files. Builds replace `dist/` with `index.js`, `index.cjs`,
`index.d.ts` and `index.d.cts` (ES modules, CommonJS and TypeScript declarations).
These are the only build files included in the npm package; `npm pack` and
`npm publish` rebuild them automatically.

Biome checks formatting, imports and lint rules for source, tests and scripts. Run
`npm run check:fix` to apply fixes or `npm run format` to format only. CI runs
`npm run check:ci` and treats warnings as failures.

Tests cover syntax, range/mixed parsing, node vocabulary and parse performance.
[incremental.test.ts](test/incremental.test.ts) compares incremental and full
trees through boundary edits and successive edits of real fixtures.
[fuzz.test.ts](test/fuzz.test.ts) both generates documents from
Carve constructs and edits fixtures one character at a time, checking tree
bounds, non-overlapping siblings and deterministic output.

Upstream corpus inputs and Carve demos are in `test/corpus/` and
`test/fixtures/`. Node-name and layout checks also use two downloaded files in
`test/data/`; those checks skip when the files are absent. The
[test workflow](.github/workflows/tests.yml) contains the fetch commands and
requires both files.
