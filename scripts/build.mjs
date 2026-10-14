import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readdirSync, rmSync, unlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const dist = join(root, "dist")
const tests = join(root, "test")
const require = createRequire(import.meta.url)
const helper = require.resolve("@codemirror/buildhelper/bin/cm-buildhelper.js")

// Only clean this package's real dist directory.
if (existsSync(dist) && !lstatSync(dist).isDirectory()) {
  throw new Error(`Refusing to clean a file or linked directory: ${dist}`)
}
rmSync(dist, { recursive: true, force: true })

// buildhelper also emits JavaScript beside tests. Remove those generated files
// so imports such as ./helpers.js keep resolving to the TypeScript sources.
function cleanTests() {
  if (!existsSync(tests)) return
  for (const file of readdirSync(tests, { withFileTypes: true })) {
    if (!file.isFile()) continue
    const source = file.name.replace(/\.(?:js|d\.ts)(?:\.map)?$/, ".ts")
    if (source !== file.name && existsSync(join(tests, source))) {
      unlinkSync(join(tests, file.name))
    }
  }
}

cleanTests()
try {
  const result = spawnSync(process.execPath, [helper, join(root, "src/index.ts")], {
    cwd: root,
    stdio: "inherit"
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  cleanTests()
}
