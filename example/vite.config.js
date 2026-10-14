import {fileURLToPath} from "node:url"
import {defineConfig} from "vite"

const path = relative => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {"lezer-carve": path("../src/index.ts")},
    dedupe: ["@lezer/common"]
  },
  server: {
    fs: {allow: [path("../")]}
  },
  build: {target: "es2022"}
})
