// generate-home.mjs 的测试:纯函数单测 + 临时目录子进程集成测试
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  splitFrontmatter,
  slugifyMdPath,
  splitOrderPrefix,
  extractExcerpt,
  scanContent,
  renderHome,
} from "./generate-home.mjs"

const SCRIPT = fileURLToPath(new URL("./generate-home.mjs", import.meta.url))

function makeContent(files) {
  const dir = mkdtempSync(join(tmpdir(), "genhome-test-"))
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text, "utf8")
  }
  return dir
}

const md = (fm, body = "正文。") => `---\n${fm}\n---\n\n${body}\n`

describe("generate-home 纯函数", () => {
  it("splitFrontmatter:解析 YAML 头,容忍无头/坏头", () => {
    const { fm, body } = splitFrontmatter(`---\ntitle: 测试\n---\n正文`)
    assert.equal(fm.title, "测试")
    assert.equal(body, "正文")
    assert.deepEqual(splitFrontmatter("没有头").fm, {})
    assert.deepEqual(splitFrontmatter(`---\n: {{bad\n---\nx`).fm, {})
  })

  it("slugifyMdPath:与 Quartz slugifyPath 规则一致(空格→-,小写,中文保留)", () => {
    assert.equal(
      slugifyMdPath("1 - AI/00 - Agent/Agent Hooks：控制.md"),
      "1---ai/00---agent/agent-hooks：控制",
    )
    assert.equal(slugifyMdPath("a/B & C/d?#.md"), "a/b--and--c/d")
  })

  it("splitOrderPrefix:拆「NN - 名称」前缀", () => {
    assert.deepEqual(splitOrderPrefix("03 - 一文玩转 Claude Code"), {
      num: "03",
      name: "一文玩转 Claude Code",
    })
    assert.deepEqual(splitOrderPrefix("无前缀目录"), { num: null, name: "无前缀目录" })
  })

  it("extractExcerpt:剥离 callout/wikilink/代码块/标题,截断加省略号", () => {
    const body = [
      "> [!abstract] 摘要",
      "> 这是一段引用",
      "## 标题",
      "```js",
      "code()",
      "```",
      "正文带 [[链接|别名]] 和 **加粗**。",
    ].join("\n")
    const out = extractExcerpt(body, 30)
    assert.ok(!out.includes("[!abstract]"))
    assert.ok(!out.includes("code()"))
    assert.ok(!out.includes("##"))
    assert.ok(out.includes("别名"))
    const long = extractExcerpt("字".repeat(200), 10)
    assert.equal(long, "字".repeat(10) + "…")
  })
})

describe("generate-home 扫描与渲染", () => {
  it("根级 md 进精选,子目录成专题且按日期倒序;HTML 块内无空行", () => {
    const dir = makeContent({
      "1 - AI/01 - 工具集.md": md(`title: 01 - 工具集\ndescription: 工具描述`),
      "1 - AI/00 - Agent/旧文.md": md(`title: 旧文\ncreated: 2025-01-01\ndescription: 旧`),
      "1 - AI/00 - Agent/新文.md": md(`title: 新文\ncreated: 2026-02-02\ndescription: 新`),
      "1 - AI/00 - Agent/嵌套/更深.md": md(`title: 更深\ncreated: 2024-01-01\ndescription: 深`),
    })
    try {
      const data = scanContent(dir)
      assert.equal(data.featured.length, 1)
      assert.equal(data.featured[0].title, "01 - 工具集")
      assert.equal(data.sections.length, 1)
      assert.deepEqual(
        data.sections[0].articles.map((a) => a.title),
        ["新文", "旧文", "更深"],
      )
      assert.equal(data.sections[0].name, "Agent")

      const out = renderHome(data)
      assert.match(out, /cssclasses:\n {2}- home/)
      assert.match(out, /<b>4<\/b> 篇笔记/)
      assert.match(out, /href="\/1---ai\/01---工具集"/)
      assert.match(out, /href="\/1---ai\/00---agent\/嵌套\/更深"/)
      // HTML 块内部不能有空行(CommonMark HTML block 在空行中断)
      for (const block of out.split("\n\n").slice(1)) {
        assert.ok(!/\n\s*\n/.test(block), `块内出现空行:\n${block.slice(0, 120)}`)
      }
      // <a> 内不得出现块级标签:HTML 解析器会把 a 容错拆分,卡片结构碎裂
      for (const m of out.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)) {
        assert.ok(
          !/<(h[1-6]|p|div|section|header)\b/.test(m[1]),
          `a 内出现块级标签: ${m[0].slice(0, 100)}`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HTML 转义:标题/描述中的 <>&" 不会注入标签', () => {
    const dir = makeContent({
      "1 - AI/00 - 专题/注入.md": md(`title: "<script>&\\"x\\""\ndescription: "a<b>c"`),
    })
    try {
      const out = renderHome(scanContent(dir))
      assert.ok(!out.includes("<script>"))
      assert.ok(out.includes("&lt;script&gt;"))
      assert.ok(out.includes("a&lt;b&gt;c"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("集成:覆盖 index.md 且幂等;无文章时保持 index.md 原样", () => {
    const dir = makeContent({
      "index.md": "---\ntitle: 旧首页\n---\n旧内容\n",
      "1 - AI/00 - Agent/文.md": md(`title: 文\ncreated: 2026-01-01\ndescription: 描述`),
    })
    try {
      const r1 = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" })
      assert.equal(r1.status, 0, r1.stderr)
      assert.match(r1.stdout, /已生成首页: 1 篇/)
      const first = readFileSync(join(dir, "index.md"), "utf8")
      assert.ok(first.includes("home-hero"))
      const r2 = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" })
      assert.equal(r2.status, 0, r2.stderr)
      assert.equal(readFileSync(join(dir, "index.md"), "utf8"), first, "二次运行产物应一致")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    const empty = makeContent({ "index.md": "---\ntitle: 旧首页\n---\n旧内容\n" })
    try {
      const r = spawnSync(process.execPath, [SCRIPT, empty], { encoding: "utf8" })
      assert.equal(r.status, 0, r.stderr)
      assert.match(r.stdout, /保持 index\.md 原样/)
      assert.equal(
        readFileSync(join(empty, "index.md"), "utf8"),
        "---\ntitle: 旧首页\n---\n旧内容\n",
      )
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("集成:目录不存在时退出码 1", () => {
    const ghost = join(tmpdir(), "genhome-ghost-不存在")
    assert.ok(!existsSync(ghost))
    const r = spawnSync(process.execPath, [SCRIPT, ghost], { encoding: "utf8" })
    assert.equal(r.status, 1)
  })
})
