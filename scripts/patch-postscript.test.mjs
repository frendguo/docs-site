// patch-postscript.mjs 的单测: 验证注入幂等性及语法合法性
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MARKER, RUNTIME_SNIPPET, patchPostscript } from "./patch-postscript.mjs"

describe("patch-postscript", () => {
  it("RUNTIME_SNIPPET 语法合法", () => {
    assert.doesNotThrow(() => new Function(RUNTIME_SNIPPET))
  })

  it("向带 hash 的 postscript-*.js 注入补丁且幂等", () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-ps-"))
    try {
      const target = join(dir, "postscript-d434c808.js")
      const other = join(dir, "prescript-1234abcd.js")
      writeFileSync(target, "console.log('orig');\n", "utf8")
      writeFileSync(other, "console.log('pre');\n", "utf8")

      const r1 = patchPostscript(dir)
      assert.deepEqual(r1, { total: 1, patched: 1 })
      const once = readFileSync(target, "utf8")
      assert.ok(once.includes(MARKER))
      assert.equal(readFileSync(other, "utf8"), "console.log('pre');\n")

      const r2 = patchPostscript(dir)
      assert.deepEqual(r2, { total: 1, patched: 0 })
      assert.equal(readFileSync(target, "utf8"), once, "二次运行应幂等")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
