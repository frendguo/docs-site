// adapt-obsidian.mjs 的单测:纯函数 adapt() 的转换规则 + CLI 集成(临时目录)
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { adapt } from "./adapt-obsidian.mjs"

const SCRIPT = fileURLToPath(new URL("./adapt-obsidian.mjs", import.meta.url))

describe("adapt: Obsidian 反斜杠转义尖括号", () => {
  it("普通文本中 \\< \\> 解除转义", () => {
    assert.equal(adapt("a \\< b 且 c \\> d"), "a < b 且 c > d")
  })

  it("解除转义后命中 HTML 白名单则保留为真标签", () => {
    assert.equal(adapt("换行\\<br\\>继续"), "换行<br>继续")
  })

  it("解除转义后是伪标签则转为可见文本", () => {
    assert.equal(adapt("占位 \\<your-token\\> 这样"), "占位 &lt;your-token&gt; 这样")
  })
})

describe("adapt: 伪标签转义", () => {
  it("白名单外的伪标签(含闭合形式)转为 &lt; &gt;", () => {
    assert.equal(adapt("<name>"), "&lt;name&gt;")
    assert.equal(adapt("</name>"), "&lt;/name&gt;")
    assert.equal(adapt("<path>"), "&lt;path&gt;")
  })

  it("带属性的伪标签整体转义", () => {
    assert.equal(adapt('<custom attr="1">'), '&lt;custom attr="1"&gt;')
  })

  it("白名单标签保留,大小写不敏感,支持属性与自闭合", () => {
    assert.equal(adapt("<sup>1</sup>"), "<sup>1</sup>")
    assert.equal(adapt("<DIV>x</DIV>"), "<DIV>x</DIV>")
    assert.equal(adapt('<img src="a.png">'), '<img src="a.png">')
    assert.equal(adapt("<br/>"), "<br/>")
  })

  it("非标签形态的尖括号(如 a < b)不动", () => {
    assert.equal(adapt("1 < 2 且 3 > 2"), "1 < 2 且 3 > 2")
  })
})

describe("adapt: 代码区保护", () => {
  it("围栏代码块内的伪标签不转义", () => {
    const src = "前\n```ts\nconst a: Array<fake> = []\n```\n后 <fake>"
    assert.equal(adapt(src), "前\n```ts\nconst a: Array<fake> = []\n```\n后 &lt;fake&gt;")
  })

  it("行内代码内的伪标签不转义", () => {
    assert.equal(adapt("用 `<fake>` 表示,但 <fake> 要转"), "用 `<fake>` 表示,但 &lt;fake&gt; 要转")
  })

  it("反斜杠解除转义对代码区同样生效(现状行为)", () => {
    assert.equal(adapt("`\\<x\\>`"), "`<x>`")
  })
})

describe("adapt: 幂等性", () => {
  it("二次运行结果不变", () => {
    const src = "占位 \\<token\\>,真标签 <sup>1</sup>,伪标签 <name>,代码 `<fake>`"
    const once = adapt(src)
    assert.equal(adapt(once), once)
  })
})

describe("CLI 集成", () => {
  it("递归扫描目录、只改 md、重写后幂等", () => {
    const dir = mkdtempSync(join(tmpdir(), "adapt-test-"))
    try {
      mkdirSync(join(dir, "sub"))
      writeFileSync(join(dir, "sub", "a.md"), "占位 \\<token\\>", "utf8")
      writeFileSync(join(dir, "clean.md"), "无需修改", "utf8")
      writeFileSync(join(dir, "b.txt"), "非 md \\<token\\>", "utf8")

      const r1 = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" })
      assert.equal(r1.status, 0)
      assert.match(r1.stdout, /扫描 2 个 Markdown,修改 1 个/)
      assert.equal(readFileSync(join(dir, "sub", "a.md"), "utf8"), "占位 &lt;token&gt;")
      assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "非 md \\<token\\>")

      const r2 = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" })
      assert.equal(r2.status, 0)
      assert.match(r2.stdout, /修改 0 个/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
