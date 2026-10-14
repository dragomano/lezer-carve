# Carve parser lab

An interactive visual guide to `lezer-carve`, built with Vite, plain JavaScript
and SVG. The example imports the local parser sources; it does not depend on
`codemirror-carve` or render a Carve document.

From the `lezer-carve` repository root:

```bash
npm install --prefix example
npm run example
```

Open the local URL printed by Vite. To build and preview:

```bash
npm run build --prefix example
npm run preview --prefix example
```

## What to explore

- **Parsing pipeline:** select a stage to learn how source indexing, block
  layout, inline spans and tree building fit together. This is an architectural
  explanation, not an execution trace or four separate document passes.
- **Live syntax tree:** edit the source or choose text, container, citation and
  opaque-content samples. Select an SVG node to highlight its source range;
  click in the source to select its innermost syntax node. Offsets are UTF-16
  positions and ranges are end-exclusive.
- **Tree navigation:** toggle punctuation nodes, collapse the selected branch,
  expand all branches, zoom or fit the diagram. Tree nodes support Enter/Space
  to select and Left/Right to collapse/expand. Editing the source resets the
  tree selection and the stepped job.
- **Optional syntax:** turn `citations` on or off to compare trees. The default
  `raw` extension remains enabled. Fenced JavaScript has an opaque payload in
  this example because no nested language parser is attached.
- **Lazy parsing:** each button press calls the real `advance()` method and
  shows `parsedPos`. Processing the last block still returns `null`; the next
  call returns the finished `Tree`. The finished tree is checked against the
  full parse, including node names and ranges.
- **Incremental reuse:** apply or undo a predefined edit to a middle paragraph.
  `TreeFragment.addTree` and `applyChanges` map the old tree through the change.
  Green blocks are the exact same subtree objects; amber blocks are rebuilt.
  The incremental result is checked against a fresh full parse. Input,
  configuration and boundary lookahead must all remain intact for reuse.

The short reuse example passes `0` as the fragment minimum gap so small intact
blocks remain eligible. This controls fragment retention; it does not disable
the parser's reuse checks. Real edits near a boundary may invalidate an adjacent
block too.

The explorer accepts up to 24,000 UTF-16 code units and displays up to 220 visible
nodes at once. The parser still builds the full tree. Collapse branches to
explore large trees without a large SVG. Parse timings are single browser
measurements, not benchmark results. Nothing is stored or sent to a server.

## Source layout

`main.js` connects the controls and SVG diagrams. `model.js` reads actual tree
nodes, lays out visible branches and checks incremental results. `samples.js`
contains the editable examples. `vite.config.js` aliases `lezer-carve` to
`../src/index.ts` and deduplicates `@lezer/common` so both use one runtime.

The example has its own dependencies and lockfile. Its build output is ignored
and does not enter the parser's published npm archive. Fonts, styles and diagrams
are local; no CDN libraries are loaded at runtime.
