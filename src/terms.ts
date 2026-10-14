import { NodeSet, NodeType } from "@lezer/common"

/**
 * The node hierarchy, as `[name, parentName]` pairs. Ids are assigned in array
 * order, so reordering this array is a breaking change for anything that
 * stores trees.
 *
 * Names mirror `markup-carve/tree-sitter-carve`'s `src/node-types.json` so the
 * two ecosystems read alike — but not blindly. That file lists nodes the
 * language never produces, because tree-sitter's LR machinery needs nodes the
 * grammar does not mean. This table carries only what a parser actually emits,
 * and `test/names.test.ts` holds the list of deliberate omissions with the
 * reason for each.
 *
 * The omitted ones fall into three groups:
 *
 *   - Artifacts of tree-sitter's external scanner, which needs a node to hang
 *     the delimiter it has just consumed on: `literal_marker`, `math_marker`,
 *     `language_marker`, `fixme`.
 *   - Bridge-only wrappers a foreign format may carry through: `section` and
 *     `section_content` (`ast-schema.json`: "sectioning is implicit in heading
 *     level, so a parser does not produce it"), `image_description`.
 *   - Constructs belonging to another syntax that shares the file: `note` and
 *     `todo` are a `:::` container's type name and a `%%%` fence's info string,
 *     not nodes of their own.
 *
 * Two nodes are added on top of the upstream list — `span` and `link_mark` —
 * because tree-sitter models link brackets as bare punctuation and Lezer needs
 * a name for every token it emits.
 *
 * A few nodes carry values that vary per instance rather than per type (a
 * heading's depth, a fence's width, a `:::` container's kind). Those are not
 * node properties here — a `NodeProp` lives on the type — so consumers read
 * them off the tree: a heading's level is the length of its `marker` child,
 * and a container's kind is the text of its `admonition_type`,
 * `line_block_marker`, `local_hard_break_marker`, `block_quote_fence_marker`
 * or `figure_group_marker` child.
 */
export const NODE_SPEC: readonly (readonly [name: string, parent: string | null])[] = [
  ["document", null],

  // --- Block containers -----------------------------------------------------
  ["paragraph", "document"],
  ["content", "paragraph"],
  ["frontmatter", "document"],
  ["frontmatter_marker", "frontmatter"],
  ["frontmatter_content", "frontmatter"],
  ["fenced_comment_block", "document"],
  ["comment_fence_marker_begin", "fenced_comment_block"],
  ["comment_fence_info", "fenced_comment_block"],
  ["comment_fence_marker_end", "fenced_comment_block"],
  ["comment_line", "document"],
  ["comment", "document"],
  ["braced_comment", "document"],

  // --- Simple block elements ------------------------------------------------
  ["heading", "document"],
  ["marker", "heading"],
  ["thematic_break", "document"],
  ["hard_line_break", "document"],

  // --- Quotes ---------------------------------------------------------------
  ["block_quote", "document"],
  ["block_quote_marker", "block_quote"],
  ["block_quote_fence_marker", "block_quote"],

  // --- Lists ----------------------------------------------------------------
  ["list", "document"],
  ["definition_list", "document"],
  ["list_item", "list"],
  ["list_item_content", "list_item"],
  ["term", "list_item"],
  ["definition", "list_item"],
  ["list_marker_task", "list_item"],
  ["checked", "list_marker_task"],
  ["unchecked", "list_marker_task"],
  ["list_continuation_marker", "list_item"],
  ["list_marker_dash", "list_item"],
  ["list_marker_star", "list_item"],
  ["list_marker_definition", "list_item"],
  ["list_marker_description", "list_item"],
  ["list_marker_decimal_period", "list_item"],
  ["list_marker_decimal_paren", "list_item"],
  ["list_marker_decimal_parens", "list_item"],
  ["list_marker_lower_alpha_period", "list_item"],
  ["list_marker_lower_alpha_paren", "list_item"],
  ["list_marker_lower_alpha_parens", "list_item"],
  ["list_marker_upper_alpha_period", "list_item"],
  ["list_marker_upper_alpha_paren", "list_item"],
  ["list_marker_upper_alpha_parens", "list_item"],
  ["list_marker_lower_roman_period", "list_item"],
  ["list_marker_lower_roman_paren", "list_item"],
  ["list_marker_lower_roman_parens", "list_item"],
  ["list_marker_upper_roman_period", "list_item"],
  ["list_marker_upper_roman_paren", "list_item"],
  ["list_marker_upper_roman_parens", "list_item"],

  // --- Fenced bodies --------------------------------------------------------
  ["code_block", "document"],
  ["code_block_marker_begin", "code_block"],
  ["code_block_header", "code_block"],
  ["language", "code_block_header"],
  ["code_block_label", "code_block_header"],
  ["code", "code_block"],
  ["code_block_marker_end", "code_block"],
  ["raw_block", "document"],
  ["raw_block_marker_begin", "raw_block"],
  ["raw_block_info", "raw_block"],
  ["raw_block_marker_end", "raw_block"],

  // --- Colon containers -----------------------------------------------------
  // `:::` opens every one of these: a typed admonition/div, a fenced quote
  // (`:::` >`), a layout-preserving block (`:::` |), a local-hard-break block
  // (`:::` \) and a composite figure (`:::` figure). `containerType` says
  // which. The closer must repeat the opener's exact colon count.
  ["div", "document"],
  ["div_marker_begin", "div"],
  ["div_title", "div"],
  ["div_marker_end", "div"],
  ["admonition_type", "div"],
  ["line_block_marker", "div"],
  ["local_hard_break_marker", "div"],
  ["figure_group_marker", "div"],

  // --- Tables ---------------------------------------------------------------
  ["table", "document"],
  ["table_header", "table"],
  ["table_separator", "table"],
  ["table_row", "table"],
  ["table_continuation_row", "table"],
  ["table_cell", "table"],
  ["table_cell_alignment", "table_cell"],
  ["table_cell_attributes", "table_cell"],
  ["table_caption", "table"],
  ["caption", "caption"],
  ["caption_marker", "caption"],
  ["caption_content", "caption"],

  // --- Invisible blocks -----------------------------------------------------
  ["link_reference_definition", "document"],
  ["link_label", "document"],
  ["link_destination", "document"],
  ["link_title", "document"],
  ["link_text", "document"],
  ["footnote", "document"],
  ["footnote_marker_begin", "footnote"],
  ["footnote_content", "footnote"],
  ["footnote_marker_end", "footnote"],
  ["abbreviation_definition", "document"],
  ["abbreviation_marker", "abbreviation_definition"],

  // --- Attributes -----------------------------------------------------------
  ["inline_attribute", "document"],
  ["block_attribute", "document"],
  ["key_value", "document"],
  ["key", "key_value"],
  ["value", "key_value"],
  ["identifier", "document"],
  ["class_name", "document"],
  ["boolean_attribute", "document"],
  ["language_attribute", "document"],

  // --- Citations (Tier-2) ---------------------------------------------------
  ["citation_definition", "document"],
  ["citation_label", "citation_definition"],
  ["citation_entry", "citation_definition"],
  ["citation_group", "document"],

  // --- Inline spans ---------------------------------------------------------
  ["emphasis", "document"],
  ["emphasis_begin", "emphasis"],
  ["emphasis_end", "emphasis"],
  ["strong", "document"],
  ["strong_begin", "strong"],
  ["strong_end", "strong"],
  ["bold_italic", "document"],
  ["bold_italic_begin", "bold_italic"],
  ["bold_italic_end", "bold_italic"],
  ["underline", "document"],
  ["underline_begin", "underline"],
  ["underline_end", "underline"],
  ["strikethrough", "document"],
  ["strikethrough_begin", "strikethrough"],
  ["strikethrough_end", "strikethrough"],
  ["highlighted", "document"],
  ["highlighted_begin", "highlighted"],
  ["highlighted_end", "highlighted"],
  ["insert", "document"],
  ["insert_begin", "insert"],
  ["insert_end", "insert"],
  ["delete", "document"],
  ["delete_begin", "delete"],
  ["delete_end", "delete"],
  ["substitution", "document"],
  ["editorial_comment", "document"],
  ["superscript", "document"],
  ["superscript_begin", "superscript"],
  ["superscript_end", "superscript"],
  ["subscript", "document"],
  ["subscript_begin", "subscript"],
  ["subscript_end", "subscript"],

  // --- Inline code, math, raw ------------------------------------------------
  ["verbatim", "document"],
  ["verbatim_marker_begin", "verbatim"],
  ["verbatim_marker_end", "verbatim"],
  ["inline_literal", "document"],
  ["literal_marker_begin", "inline_literal"],
  ["literal_marker_end", "inline_literal"],
  ["math", "document"],
  ["math_marker_begin", "math"],
  ["math_marker_end", "math"],
  ["raw_inline", "document"],
  ["raw_inline_marker_begin", "raw_inline"],
  ["raw_inline_attribute", "raw_inline"],
  ["raw_inline_marker_end", "raw_inline"],

  // --- Links and images -----------------------------------------------------
  // `span` and `link_mark` are the two nodes tree-sitter models with bare
  // punctuation; Lezer needs a name for every token we emit.
  ["span", "document"],
  ["link_mark", "document"],
  ["inline_link", "document"],
  ["inline_link_destination", "inline_link"],
  ["autolink", "document"],
  ["auto_text_link", "document"],
  ["full_reference_link", "document"],
  ["collapsed_reference_link", "document"],
  ["full_reference_image", "document"],
  ["collapsed_reference_image", "document"],
  ["inline_image", "document"],
  ["inline_note", "document"],
  ["footnote_reference", "document"],
  ["reference_label", "document"],

  // --- Names, symbols, punctuation ------------------------------------------
  ["symbol", "document"],
  ["mention", "document"],
  ["tag", "document"],
  ["extension_inline", "document"],
  ["extension_marker_begin", "extension_inline"],
  ["args", "extension_inline"],
  ["backslash_escape", "document"],
  ["ellipsis", "document"],
  ["en_dash", "document"],
  ["em_dash", "document"],
  ["quotation_marks", "document"]
]

type Props = NonNullable<Parameters<typeof NodeType.define>[0]["props"]>

/** Parent name by node name, for consumers that need the hierarchy up front. */
export const NODE_PARENTS: ReadonlyMap<string, string> = new Map(
  NODE_SPEC.filter((entry): entry is readonly [string, string] => entry[1] != null).map(
    ([name, parent]) => [name, parent]
  )
)

/** Ids are assigned in `NODE_SPEC` order; ids are stable across releases. */
export const NODE_IDS: ReadonlyMap<string, number> = new Map(
  NODE_SPEC.map(([name], id) => [name, id])
)

/**
 * Build a `NodeSet` from `NODE_SPEC`.
 *
 * `extraProps` lets a consumer attach its own node props — most usefully the
 * `styleTags` prop from `@lezer/highlight` that drives highlighting — without
 * `lezer-carve` taking a dependency on it.
 */
export function buildNodeSet(extraProps: Readonly<Record<string, Props>> = {}): NodeSet {
  checkSpec()
  const types = NODE_SPEC.map(([name], id) => {
    let props: Props = []
    const extra = extraProps[name]
    if (extra) props = props.concat(extra)
    return NodeType.define({
      id,
      name,
      top: NODE_PARENTS.get(name) == null,
      props: props.length ? props : undefined
    })
  })
  return new NodeSet(types)
}

/**
 * Validate the node specification. Runs at module load so a malformed table
 * fails at import rather than producing a subtly wrong tree.
 */
function checkSpec(): void {
  const seen = new Set<string>()
  for (const [name, parent] of NODE_SPEC) {
    if (seen.has(name)) throw new Error(`Duplicate node type in NODE_SPEC: ${name}`)
    seen.add(name)
    if (parent != null && !seen.has(parent)) {
      throw new Error(`Node type ${name} names a parent declared after it: ${parent}`)
    }
  }
}

/** A node set carrying only the parser's structural props. */
export const carveNodeSet: NodeSet = /*@__PURE__*/ buildNodeSet()

export const DocumentType: NodeType = carveNodeSet.types[0]

/** Resolve a node name to its type, or `null` when the name is unknown. */
export function nodeTypeByName(set: NodeSet, name: string): NodeType | null {
  return set.types.find(type => type.name === name) || null
}

/**
 * Name-to-id lookup handed to the parser phases, so emitters can write
 * `ids.paragraph` instead of a numeric literal.
 */
export type Ids = { [name: string]: number }

/** Build the {@link Ids} map for a node set. */
export function makeIds(set: NodeSet): Ids {
  const ids: Ids = Object.create(null)
  for (const type of set.types) ids[type.name] = type.id
  return ids
}
