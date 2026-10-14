import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // Tests run against the TypeScript sources, not built output, so a failing
    // assertion points at the line that caused it.
    alias: [
      {
        find: "lezer-carve",
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url))
      }
    ]
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node"
  }
})
