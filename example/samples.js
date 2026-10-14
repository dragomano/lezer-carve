export const samples = {
  basics: {
    label: "01 / Text & spans",
    description: "A heading and two paragraphs. Open a branch to see the inline spans inside each block.",
    source: "# A little Carve\n\nA *bold* idea and /quiet/ details.\n\nThe next block starts after a blank line.\n"
  },
  nesting: {
    label: "02 / Nested containers",
    description: "A quote owns a list; the list owns its items. Container prefixes remain visible as marker nodes.",
    source: "# Inside a container\n\n> A *quoted* idea.\n> - First item\n> - Second /item/\n\n::: note \"A useful detail\"\nContainers can hold *inline spans*.\n:::\n"
  },
  citations: {
    label: "03 / Citations",
    description: "Turn the citations extension off and on to see how optional syntax changes the tree.",
    source: "# Reading notes\n\nOne source [@smith2020], or several [see @smith2020, p. 4; -@jones2019].\n\n[@smith2020]: {author=\"Smith\" year=\"2020\"} *A Study*.\n[@jones2019]: Jones. /Notes on Markup/.\n"
  },
  opaque: {
    label: "04 / Opaque content",
    description: "Code, raw content and comments keep their payload opaque. A JavaScript parser is not attached in this demo.",
    source: "# Syntax has boundaries\n\n```js\nconst text = \"*not bold*\";\n```\n\n```=html\n<strong>*Raw content*</strong>\n```\n\n%%%\n*Not an inline span inside a comment.*\n%%%\n"
  }
}

export const incrementalSource = "# A stable heading\n\nThe first paragraph stays the same.\n\nA small edit belongs here.\n\nThe last paragraph stays the same.\n\n# A stable ending\n"
