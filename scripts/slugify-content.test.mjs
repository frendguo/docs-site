// slugify-content.mjs 的单元测试与集成测试
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  sanitizeSlug,
  fallbackHashSlug,
  ensureFrontmatterTitle,
  rewriteLinksInMarkdown,
  callDeepSeekBatch,
  slugifyContent,
} from "./slugify-content.mjs"
import { scanContent, renderHome } from "./generate-home.mjs"

function makeWorkspace(files) {
  const dir = mkdtempSync(join(tmpdir(), "slugify-test-"))
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, ...rel.split("/"))
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, text, "utf8")
  }
  return dir
}

describe("slugify-content 纯函数", () => {
  it("sanitizeSlug: 规范化为小写 kebab-case 并在词边界截断", () => {
    assert.equal(sanitizeSlug("Claude Code's Team Review!"), "claude-codes-team-review")
    assert.equal(sanitizeSlug("  --AI   &  MCP--  "), "ai-mcp")
    assert.equal(sanitizeSlug("纯中文标题"), "")
    const long = sanitizeSlug(
      "building-a-really-long-agent-harness-for-production-engineering-teams",
      32,
    )
    assert.ok(long.length <= 32, `长度超限: ${long}`)
    assert.ok(!long.endsWith("-"))
  })

  it("ensureFrontmatterTitle: 无 title 时补全,已有 title 时保持原样", () => {
    const noFm = "正文内容"
    const res1 = ensureFrontmatterTitle(noFm, "01 - AI 工具集")
    assert.match(res1, /^---\ntitle: "01 - AI 工具集"\n---\n\n正文内容$/)

    const fmNoTitle = "---\ntags:\n  - ai\n---\n正文"
    const res2 = ensureFrontmatterTitle(fmNoTitle, "Agent Hooks：控制")
    assert.match(res2, /^---\ntitle: "Agent Hooks：控制"\ntags:\n/)

    const fmWithTitle = "---\ntitle: 自定义标题\n---\n正文"
    assert.equal(ensureFrontmatterTitle(fmWithTitle, "原文件名"), fmWithTitle)
  })

  it("rewriteLinksInMarkdown: 改写正文与 frontmatter 双链、Markdown 链接及相对图片,保护代码块", () => {
    const entryA = {
      oldRelPath: "1 - AI/00 - ClaudeCode 实践/团队代码评审.md",
      oldRelWithoutStripRoot: "00 - ClaudeCode 实践/团队代码评审.md",
      oldDir: "1 - AI/00 - ClaudeCode 实践",
      oldStem: "团队代码评审",
      oldQuartzSlug: "1---ai/00---claudecode-实践/团队代码评审",
      newDir: "claude-code",
      newRelPath: "claude-code/team-code-review.md",
      newQuartzSlug: "claude-code/team-code-review",
    }
    const entryB = {
      oldRelPath: "1 - AI/00 - 原文存档/How Team Reviews.md",
      oldRelWithoutStripRoot: "00 - 原文存档/How Team Reviews.md",
      oldDir: "1 - AI/00 - 原文存档",
      oldStem: "How Team Reviews",
      oldQuartzSlug: "1---ai/00---原文存档/how-team-reviews",
      newDir: "originals",
      newRelPath: "originals/team-reviews.md",
      newQuartzSlug: "originals/team-reviews",
    }
    // 构造与 buildLinkIndex 相同结构的索引
    const linkIndex = {
      byOldRelNoExt: new Map([
        ["1 - ai/00 - claudecode 实践/团队代码评审", entryA],
        ["1 - ai/00 - 原文存档/how team reviews", entryB],
      ]),
      byOldSubPathNoExt: new Map([
        ["00 - claudecode 实践/团队代码评审", entryA],
        ["00 - 原文存档/how team reviews", entryB],
      ]),
      byOldQuartzSlug: new Map([
        [entryA.oldQuartzSlug, entryA],
        [entryB.oldQuartzSlug, entryB],
      ]),
      byOldStem: new Map([
        ["团队代码评审", [entryA]],
        ["how team reviews", [entryB]],
      ]),
      byOldStemSlug: new Map([
        ["团队代码评审", [entryA]],
        ["how-team-reviews", [entryB]],
      ]),
    }

    const raw = [
      "---",
      'title: "测试"',
      'translation: "[[How Team Reviews]]"',
      "---",
      "",
      "参见 [[团队代码评审]]、[[团队代码评审#核心原则]]、[[团队代码评审|评审指南]]。",
      "| 列 | [[团队代码评审\\|表格别名]] |",
      "图片保持: ![[demo.png]] 与相对图 ![图](../../99%20-%20images/pic.png)",
      "未匹配保持: [[@dabit3]]",
      "行内代码保护: `[[团队代码评审]]`",
      "```md",
      "[[团队代码评审]]",
      "```",
      "",
    ].join("\n")

    const out = rewriteLinksInMarkdown(raw, entryA, linkIndex)
    assert.ok(out.includes('translation: "[[originals/team-reviews|How Team Reviews]]"'))
    assert.ok(out.includes("[[claude-code/team-code-review|团队代码评审]]"))
    assert.ok(out.includes("[[claude-code/team-code-review#核心原则|团队代码评审]]"))
    assert.ok(out.includes("[[claude-code/team-code-review|评审指南]]"))
    assert.ok(out.includes("[[claude-code/team-code-review\\|表格别名]]"))
    assert.ok(out.includes("![[demo.png]]"))
    assert.ok(out.includes("![图](../99%20-%20images/pic.png)"))
    assert.ok(out.includes("[[@dabit3]]"))
    assert.ok(out.includes("`[[团队代码评审]]`"))
    assert.ok(out.includes("```md\n[[团队代码评审]]\n```"))
  })

  it("callDeepSeekBatch: 正常解析 JSON 返回并过滤非法字符,失败时降级不抛错", async () => {
    const mockFetch = async (_url, init) => {
      const payload = JSON.parse(init.body)
      assert.equal(payload.model, "deepseek-chat")
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  slugs: {
                    "article:a": "Team Code Review!",
                    "article:b": "纯中文无效",
                  },
                }),
              },
            },
          ],
        }),
      }
    }

    const map = await callDeepSeekBatch(
      [
        { id: "article:a", type: "article", folder: "claude-code", title: "团队代码评审" },
        { id: "article:b", type: "article", folder: "claude-code", title: "坏结果" },
      ],
      { apiKey: "test-key" },
      mockFetch,
    )
    assert.equal(map.get("article:a"), "team-code-review")
    assert.equal(map.has("article:b"), false)

    const failMap = await callDeepSeekBatch(
      [{ id: "article:a", type: "article", folder: "claude-code", title: "失败测试" }],
      { apiKey: "test-key" },
      async () => ({ ok: false, status: 503, text: async () => "Service Unavailable" }),
    )
    assert.equal(failMap.size, 0)
  })
})

describe("slugifyContent 集成流程", () => {
  it("剥离 1 - AI、调用 DeepSeek 仅生成新文章、复用旧映射、保护草稿、生成 _redirects 并与 generate-home 衔接", async () => {
    const ws = makeWorkspace({
      "content/index.md": "---\ntitle: AI 知识库\n---\n",
      "content/99 - images/cover.png": "PNG",
      "content/1 - AI/01 - AI 工具集.md":
        "无 frontmatter 的指南,链接到 [[Claude Code 团队如何做代码评审]]。\n",
      "content/1 - AI/00 - ClaudeCode 实践/Claude Code 团队如何做代码评审.md":
        "---\ntitle: Claude Code 团队如何做代码评审\ncreated: 2026-06-01\n---\n参考 ![图](../../99%20-%20images/cover.png)\n",
      "content/1 - AI/00 - ClaudeCode 实践/已有映射文章.md":
        "---\ntitle: 已有映射文章\ncreated: 2026-05-01\n---\n已有正文\n",
      "content/1 - AI/00 - ClaudeCode 实践/草稿文章.md":
        "---\ntitle: 机密草稿\ndraft: true\n---\n不该进映射表\n",
      "content/1 - AI/00 - 原文存档/How Team Reviews.md":
        '---\ntitle: How Team Reviews\ncreated: 2026-06-01\ntranslation: "[[Claude Code 团队如何做代码评审]]"\n---\nEnglish text\n',
      "data/slug-map.json": JSON.stringify(
        {
          version: 1,
          folders: {
            "00 - ClaudeCode 实践": "claude-code",
            "00 - 原文存档": "originals",
          },
          articles: {
            "1 - AI/00 - ClaudeCode 实践/已有映射文章.md": {
              slug: "existing-article",
              driveId: "drv-existing",
            },
          },
        },
        null,
        2,
      ),
      "drive-manifest.json": JSON.stringify([
        { Path: "00 - ClaudeCode 实践/Claude Code 团队如何做代码评审.md", ID: "drv-review" },
        { Path: "00 - ClaudeCode 实践/已有映射文章.md", ID: "drv-existing" },
        { Path: "00 - 原文存档/How Team Reviews.md", ID: "drv-orig" },
        { Path: "01 - AI 工具集.md", ID: "drv-tools" },
      ]),
    })

    const llmSeenIds = []
    const mockFetch = async (_url, init) => {
      const payload = JSON.parse(init.body)
      const items = JSON.parse(payload.messages[1].content)
      const slugs = {}
      for (const item of items) {
        llmSeenIds.push(item.id)
        if (item.id.includes("团队如何做代码评审")) slugs[item.id] = "team-code-review"
        else if (item.id.includes("How Team Reviews")) slugs[item.id] = "how-team-reviews"
        else if (item.id.includes("AI 工具集")) slugs[item.id] = "ai-tools"
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ slugs }) } }],
        }),
      }
    }

    try {
      const contentDir = join(ws, "content")
      const mapPath = join(ws, "data", "slug-map.json")
      const redirectsOut = join(ws, "redirects.txt")
      const manifestPath = join(ws, "drive-manifest.json")

      const stats = await slugifyContent({
        contentDir,
        mapPath,
        driveManifestPath: manifestPath,
        redirectsOut,
        deepseekConfig: { apiKey: "fake-key" },
        fetchImpl: mockFetch,
      })

      assert.equal(stats.skipped, false)
      assert.equal(stats.reused, 1)
      assert.equal(stats.llmGenerated, 3)

      // 已有映射与草稿绝不发给 DeepSeek
      assert.ok(!llmSeenIds.some((id) => id.includes("已有映射文章")))
      assert.ok(!llmSeenIds.some((id) => id.includes("草稿文章")))

      // 验证输出文件结构
      assert.ok(!existsSync(join(contentDir, "1 - AI")), "顶层套壳目录应被清理")
      assert.ok(existsSync(join(contentDir, "99 - images", "cover.png")), "图片目录保持不动")
      assert.ok(existsSync(join(contentDir, "ai-tools.md")))
      assert.ok(existsSync(join(contentDir, "claude-code", "team-code-review.md")))
      assert.ok(existsSync(join(contentDir, "claude-code", "existing-article.md")))
      assert.ok(existsSync(join(contentDir, "claude-code", "index.md")))
      assert.ok(existsSync(join(contentDir, "originals", "how-team-reviews.md")))

      // 验证自动补全 title 与改写双链/图片路径
      const guideText = readFileSync(join(contentDir, "ai-tools.md"), "utf8")
      assert.match(guideText, /^---\ntitle: "01 - AI 工具集"\n---/)
      assert.ok(
        guideText.includes("[[claude-code/team-code-review|Claude Code 团队如何做代码评审]]"),
      )

      const reviewText = readFileSync(
        join(contentDir, "claude-code", "team-code-review.md"),
        "utf8",
      )
      assert.ok(reviewText.includes("![图](../99%20-%20images/cover.png)"))

      const origText = readFileSync(join(contentDir, "originals", "how-team-reviews.md"), "utf8")
      assert.ok(
        origText.includes(
          'translation: "[[claude-code/team-code-review|Claude Code 团队如何做代码评审]]"',
        ),
      )

      // 验证 slug-map.json 持久化了新英文 slug 与 driveId,且不含草稿
      const savedMap = JSON.parse(readFileSync(mapPath, "utf8"))
      assert.deepEqual(
        savedMap.articles["1 - AI/00 - ClaudeCode 实践/Claude Code 团队如何做代码评审.md"],
        { slug: "team-code-review", driveId: "drv-review" },
      )
      assert.equal(savedMap.articles["1 - AI/00 - ClaudeCode 实践/草稿文章.md"], undefined)

      // 验证 _redirects(旧长链接 percent-encoded 301 到新短链接)
      const redirects = readFileSync(redirectsOut, "utf8")
      assert.ok(redirects.includes("/1---ai / 301"))
      assert.ok(
        redirects.includes(
          "/1---ai/00---claudecode-%E5%AE%9E%E8%B7%B5/claude-code-%E5%9B%A2%E9%98%9F%E5%A6%82%E4%BD%95%E5%81%9A%E4%BB%A3%E7%A0%81%E8%AF%84%E5%AE%A1 /claude-code/team-code-review 301",
        ),
      )
      assert.ok(!redirects.includes("草稿"), "草稿不生成重定向")

      // 验证幂等:再次运行自动跳过
      const stats2 = await slugifyContent({
        contentDir,
        mapPath,
        deepseekConfig: { apiKey: "fake-key" },
        fetchImpl: mockFetch,
      })
      assert.equal(stats2.skipped, true)

      // 验证与 generate-home.mjs 衔接:读取中文专题名、排除目录 index.md 与草稿、链接为新英文两级 URL
      const homeData = scanContent(contentDir)
      assert.deepEqual(
        homeData.sections.map((s) => s.name),
        ["ClaudeCode 实践", "原文存档"],
      )
      assert.equal(homeData.sections[0].articles.length, 2)
      const homeMd = renderHome(homeData)
      assert.ok(homeMd.includes('href="/claude-code/team-code-review"'))
      assert.ok(!homeMd.includes("机密草稿"))
      assert.ok(!homeMd.includes('href="/ai-tools"'), "根级指南不上首页")
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("driveId 跟踪: 文章改名并挪目录时沿用旧 slug, 并自动生成历史 301 重定向", async () => {
    const ws = makeWorkspace({
      "content/1 - AI/00 - Agent/代码评审新标题.md":
        "---\ntitle: 代码评审新标题\ncreated: 2026-06-02\n---\n正文\n",
      "data/slug-map.json": JSON.stringify({
        version: 1,
        folders: {
          "00 - Agent": "agent",
          "00 - ClaudeCode 实践": "claude-code",
        },
        articles: {
          "1 - AI/00 - ClaudeCode 实践/旧标题.md": {
            slug: "team-code-review",
            driveId: "drv-same-file",
          },
        },
      }),
      "drive-manifest.json": JSON.stringify([
        { Path: "00 - Agent/代码评审新标题.md", ID: "drv-same-file" },
      ]),
    })

    let llmCalls = 0
    try {
      const contentDir = join(ws, "content")
      const mapPath = join(ws, "data", "slug-map.json")
      const redirectsOut = join(ws, "redirects.txt")
      const stats = await slugifyContent({
        contentDir,
        mapPath,
        driveManifestPath: join(ws, "drive-manifest.json"),
        redirectsOut,
        deepseekConfig: { apiKey: "fake-key" },
        fetchImpl: async () => {
          llmCalls++
          throw new Error("不应调用 LLM")
        },
      })

      assert.equal(llmCalls, 0)
      assert.equal(stats.reused, 1)
      assert.ok(existsSync(join(contentDir, "agent", "team-code-review.md")))

      const redirects = readFileSync(redirectsOut, "utf8")
      assert.ok(
        redirects.includes("/claude-code/team-code-review /agent/team-code-review 301"),
        "跨目录移动前的旧英文 URL 应 301 跳转",
      )

      const savedMap = JSON.parse(readFileSync(mapPath, "utf8"))
      assert.equal(savedMap.articles["1 - AI/00 - ClaudeCode 实践/旧标题.md"], undefined)
      assert.equal(
        savedMap.articles["1 - AI/00 - Agent/代码评审新标题.md"].slug,
        "team-code-review",
      )
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("无 DEEPSEEK_API_KEY 时降级为短 hash,且不污染 slug-map.json", async () => {
    const ws = makeWorkspace({
      "content/1 - AI/00 - Agent/新中文文章.md": "---\ntitle: 新中文文章\n---\n正文\n",
      "data/slug-map.json": JSON.stringify({
        version: 1,
        folders: { "00 - Agent": "agent" },
        articles: {},
      }),
    })

    const prevKey = process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_API_KEY
    try {
      const contentDir = join(ws, "content")
      const mapPath = join(ws, "data", "slug-map.json")
      const stats = await slugifyContent({ contentDir, mapPath })

      assert.equal(stats.fallback, 1)
      const expectedHash = fallbackHashSlug("1 - AI/00 - Agent/新中文文章.md")
      assert.ok(existsSync(join(contentDir, "agent", `${expectedHash}.md`)))

      const savedMap = JSON.parse(readFileSync(mapPath, "utf8"))
      assert.deepEqual(savedMap.articles, {}, "兜底 hash 不应写入映射表")
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("同目录重名 slug 自动追加 -2 避免冲突", async () => {
    const ws = makeWorkspace({
      "content/1 - AI/00 - Agent/文章甲.md": "---\nslug: same-name\ntitle: 文章甲\n---\nA\n",
      "content/1 - AI/00 - Agent/文章乙.md": "---\nslug: same-name\ntitle: 文章乙\n---\nB\n",
      "data/slug-map.json": JSON.stringify({
        version: 1,
        folders: { "00 - Agent": "agent" },
        articles: {},
      }),
    })

    try {
      const contentDir = join(ws, "content")
      await slugifyContent({ contentDir, mapPath: join(ws, "data", "slug-map.json") })
      assert.ok(existsSync(join(contentDir, "agent", "same-name.md")))
      assert.ok(existsSync(join(contentDir, "agent", "same-name-2.md")))
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it("双链容错匹配: 支持半角/全角标点差异及按 frontmatter title 引用", async () => {
    const ws = makeWorkspace({
      "content/1 - AI/00 - Agent/Harness 工程：驾驭 Codex.md":
        "---\nslug: harness-codex\ntitle: Harness 工程：驾驭 Codex\n---\n正文\n",
      "content/1 - AI/00 - Agent/用 Fable 5 设计循环：自我修正与记忆.md":
        "---\nslug: fable-5-loops\ntitle: 用 Fable 5 设计循环：自我修正与记忆的两个实战技巧\n---\n正文\n",
      "content/1 - AI/00 - Agent/引用方.md": [
        "---",
        "slug: caller",
        "title: 引用方",
        "---",
        "半角冒号: [[Harness 工程:驾驭 Codex]]",
        "按完整标题: [[用 Fable 5 设计循环：自我修正与记忆的两个实战技巧]]",
        "",
      ].join("\n"),
      "data/slug-map.json": JSON.stringify({
        version: 1,
        folders: { "00 - Agent": "agent" },
        articles: {},
      }),
    })

    try {
      const contentDir = join(ws, "content")
      await slugifyContent({ contentDir, mapPath: join(ws, "data", "slug-map.json") })
      const caller = readFileSync(join(contentDir, "agent", "caller.md"), "utf8")
      assert.ok(caller.includes("[[agent/harness-codex|Harness 工程:驾驭 Codex]]"))
      assert.ok(
        caller.includes(
          "[[agent/fable-5-loops|用 Fable 5 设计循环：自我修正与记忆的两个实战技巧]]",
        ),
      )
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
