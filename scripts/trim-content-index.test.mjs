// trim-content-index.mjs 的集成测试:临时 JSON 文件 + 子进程执行
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("./trim-content-index.mjs", import.meta.url))

function runTrim(idx, limit) {
  const dir = mkdtempSync(join(tmpdir(), "trim-test-"))
  const file = join(dir, "contentIndex.json")
  writeFileSync(file, JSON.stringify(idx), "utf8")
  const run = () => spawnSync(process.execPath, [SCRIPT, file, String(limit)], { encoding: "utf8" })
  const read = () => JSON.parse(readFileSync(file, "utf8"))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { run, read, cleanup }
}

describe("trim-content-index", () => {
  it("超限截断到 limit,未超限/无 content/null 条目原样保留", () => {
    const { run, read, cleanup } = runTrim(
      {
        long: { title: "长文", content: "x".repeat(50) },
        short: { title: "短文", content: "短内容" },
        meta: { title: "无正文" },
        nil: null,
      },
      10,
    )
    try {
      const r = run()
      assert.equal(r.status, 0)
      assert.match(r.stdout, /截断 1\/4 篇,每篇保留前 10 字/)
      const after = read()
      assert.equal(after.long.content, "x".repeat(10))
      assert.equal(after.long.title, "长文")
      assert.equal(after.short.content, "短内容")
      assert.deepEqual(after.meta, { title: "无正文" })
      assert.equal(after.nil, null)
    } finally {
      cleanup()
    }
  })

  it("幂等:二次运行截断 0 篇,内容不再变化", () => {
    const { run, read, cleanup } = runTrim({ a: { content: "y".repeat(30) } }, 10)
    try {
      assert.equal(run().status, 0)
      const first = read()
      const r2 = run()
      assert.equal(r2.status, 0)
      assert.match(r2.stdout, /截断 0\/1 篇/)
      assert.deepEqual(read(), first)
    } finally {
      cleanup()
    }
  })
})
