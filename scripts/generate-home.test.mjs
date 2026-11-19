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
  pickLatest,
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
  it("根级 md 不上首页(精选指南已移除),子目录成专题且按日期倒序;HTML 块内无空行", () => {
    const dir = makeContent({
      "1 - AI/01 - 工具集.md": md(`title: 01 - 工具集\ndescription: 工具描述`),
      "1 - AI/00 - Agent/旧文.md": md(`title: 旧文\ncreated: 2025-01-01\ndescription: 旧`),
      "1 - AI/00 - Agent/新文.md": md(`title: 新文\ncreated: 2026-02-02\ndescription: 新`),
      "1 - AI/00 - Agent/嵌套/更深.md": md(`title: 更深\ncreated: 2024-01-01\ndescription: 深`),
    })
    try {
      const data = scanContent(dir)
      assert.equal(data.featured, undefined, "不再产出精选指南")
      assert.equal(data.sections.length, 1)
      assert.deepEqual(
        data.sections[0].articles.map((a) => a.title),
        ["新文", "旧文", "更深"],
      )
      assert.equal(data.sections[0].name, "Agent")

      const out = renderHome(data)
      assert.match(out, /cssclasses:\n {2}- home/)
      assert.match(out, /搜索 3 篇笔记/)
      assert.ok(!out.includes("精选指南"))
      assert.ok(!out.includes("01---工具集"), "根级文章不出现在首页")
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

  it("pickLatest:跨专题按日期倒序,同日按 slug;排除原文存档与无 frontmatter 日期的文章", () => {
    const dir = makeContent({
      "1 - AI/00 - Agent/甲.md": md(`title: 甲\ncreated: 2026-03-01`),
      "1 - AI/00 - Agent/乙.md": md(`title: 乙\ncreated: 2026-05-01`),
      "1 - AI/00 - 实践/丙.md": md(`title: 丙\ncreated: 2026-05-01`),
      "1 - AI/00 - 实践/丁.md": md(`title: 丁\ncreated: 2026-01-01`),
      // 英文原文:带 translation 指向译文,不进最新区
      "1 - AI/00 - 原文存档/Orig.md": md(`title: Orig\ncreated: 2026-09-09\ntranslation: "[[乙]]"`),
      // 无 frontmatter 日期:mtime 会被 adapt 改写,不可信,不进最新区
      "1 - AI/00 - Agent/无日期.md": md(`title: 无日期`),
    })
    try {
      const data = scanContent(dir)
      const latest = pickLatest(data.sections, 3)
      assert.deepEqual(
        latest.map((a) => a.title),
        ["乙", "丙", "甲"],
      )
      assert.equal(latest[0].section, "Agent")
      assert.equal(latest[1].section, "实践")
      // 全为原文的专题排到最后
      assert.equal(data.sections.at(-1).name, "原文存档")

      const out = renderHome(data)
      const latestPos = out.indexOf("home-latest")
      const firstSection = out.indexOf("home-section")
      assert.ok(latestPos > 0 && latestPos < firstSection, "最新更新位于专题分区之前")
      assert.ok(!/home-latest[\s\S]*Orig[\s\S]*home-section/.test(out))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("专题超过首屏条数时其余折叠进 details;hero 含可唤起站内搜索的入口与专题导航", () => {
    const files = {}
    for (let i = 1; i <= 9; i++) {
      files[`1 - AI/00 - Agent/文${i}.md`] = md(`title: 文${i}\ncreated: 2026-01-0${i}`)
    }
    const dir = makeContent(files)
    try {
      const out = renderHome(scanContent(dir))
      const section = out.slice(out.indexOf('class="home-block home-section"'))
      const [visible, folded] = section.split("<details")
      assert.equal((visible.match(/class="home-card"/g) ?? []).length, 6)
      assert.equal((folded.match(/class="home-card"/g) ?? []).length, 3)
      assert.match(folded, /展开其余 3 篇/)
      assert.match(folded, /收起其余 3 篇/)
      // 搜索入口:点击转发给 Quartz 搜索组件的按钮,无覆盖可见文本的 aria-label (WCAG 2.5.3)
      assert.match(
        out,
        /class="home-search"[^>]*aria-keyshortcuts="Control\+K Meta\+K"[^>]*onclick="[^"]*\.search-button[^"]*\.click\(\)/,
      )
      assert.doesNotMatch(out, /class="home-search"[^>]*aria-label=/)
      // 语义与可访问性:英文 kicker 标注 lang,日期用 <time datetime>,grid 列表带 role="list"
      assert.match(out, /<p class="home-kicker" lang="en">/)
      assert.match(out, /<nav class="home-topics" aria-label="专题">/)
      assert.match(out, /<ol class="home-latest-list" role="list">/)
      assert.match(out, /<time class="home-latest-date" datetime="2026-01-09">2026-01-09<\/time>/)
      assert.match(out, /<time class="home-card-meta" datetime="2026-01-09">2026-01-09<\/time>/)
      // 专题导航锚点与分区 id 对应
      assert.match(out, /href="#topic-1"/)
      assert.match(out, /id="topic-1"/)
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
      assert.match(r1.stdout, /最新 1 篇/)
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

  it("支持 slugify-content 后的干净两级目录结构(读 index.md 中文 title 与 sectionOrder,忽略 index.md 与草稿)", () => {
    const dir = makeContent({
      "ai-tools.md": md(`title: 01 - AI 工具集\ndescription: 根级指南`),
      "claude-code/index.md": md(
        `title: ClaudeCode 实践\nsectionOrder: 1\ngeneratedBy: slugify-content`,
      ),
      "claude-code/team-code-review.md": md(
        `title: Claude Code 团队如何做代码评审\ncreated: 2026-06-01`,
      ),
      "claude-code/draft-note.md": md(`title: 草稿\ndraft: true\ncreated: 2026-06-02`),
      "agent/index.md": md(`title: Agent\nsectionOrder: 0\ngeneratedBy: slugify-content`),
      "agent/context-engineering.md": md(`title: 上下文工程\ncreated: 2026-05-01`),
      "originals/index.md": md(`title: 原文存档\nsectionOrder: 2\ngeneratedBy: slugify-content`),
      "originals/review.md": md(
        `title: Code Review\ncreated: 2026-06-10\ntranslation: "[[claude-code/team-code-review|团队代码评审]]"`,
      ),
    })
    try {
      const data = scanContent(dir)
      assert.deepEqual(
        data.sections.map((s) => s.name),
        ["Agent", "ClaudeCode 实践", "原文存档"],
      )
      assert.equal(data.sections[1].articles.length, 1, "index.md 与 draft 不计入专题文章")
      const out = renderHome(data)
      assert.match(out, /href="\/claude-code\/team-code-review"/)
      assert.match(out, /href="\/agent\/context-engineering"/)
      assert.ok(!out.includes('href="/ai-tools"'), "根级 md 不上首页")
      assert.ok(!out.includes("draft-note"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
