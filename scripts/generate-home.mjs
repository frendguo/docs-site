#!/usr/bin/env node
// 首页生成器:扫描 content/ 把全部文章平铺为首页(content/index.md)
// 在 adapt-obsidian.mjs 之后、`quartz build` 之前运行。可重复运行(幂等):
// 产物完全由扫描结果决定,与 index.md 旧内容无关。
//
// 结构约定(与 CI 拉取结构一致):
//   content/<顶层目录>/*.md          → 「精选指南」目录条目(按 NN 前缀排序)
//   content/<顶层目录>/<子目录>/**.md → 每个子目录一个专题分区(按日期倒序)
// 顶层目录名/子目录名中的「NN - 」前缀仅用于排序与编号,展示时去掉。
//
// ⚠️ content/index.md 是 git 跟踪文件,本脚本会覆盖它:CI/本地预览属预期,
//    预览结束后用 `git restore content/index.md` 还原(见 /preview 技能清理步骤)。
//
// 用法: node scripts/generate-home.mjs [contentDir]   (默认 content)

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

// ---------- frontmatter ----------

export function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fm: {}, body: raw }
  let fm
  try {
    fm = parseYaml(m[1]) ?? {}
  } catch {
    fm = {}
  }
  return { fm: typeof fm === "object" && fm !== null ? fm : {}, body: raw.slice(m[0].length) }
}

// ---------- 文本工具 ----------

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

// 与 @quartz-community/utils 的 slugifyPath 一致(空格→-、&→-and-、%→-percent、?#删、小写)
export function slugifySegment(s) {
  return s
    .replace(/\s/g, "-")
    .replace(/&/g, "-and-")
    .replace(/%/g, "-percent")
    .replace(/\?/g, "")
    .replace(/#/g, "")
    .toLowerCase()
}

export function slugifyMdPath(relPath) {
  return relPath
    .split(/[\\/]/)
    .map((seg) => slugifySegment(seg.replace(/\.md$/i, "")))
    .join("/")
}

// 「NN - 名称」→ { num: "NN", name: "名称" };无前缀则 num 为 null
export function splitOrderPrefix(name) {
  const m = name.match(/^(\d+)\s*-\s*(.+)$/)
  return m ? { num: m[1], name: m[2].trim() } : { num: null, name: name.trim() }
}

// 从正文提取纯文本摘要(frontmatter 无 description 时兜底)
export function extractExcerpt(body, maxLen = 90) {
  const text = body
    .replace(/^>\s?\[![^\]]*\][+-]?.*$/gm, "") // callout 头
    .replace(/^>\s?/gm, "") // 引用前缀
    .replace(/```[\s\S]*?```/g, "") // 代码块
    .replace(/^\|.*\|\s*$/gm, "") // 表格行
    .replace(/!\[\[[^\]]*\]\]/g, "") // 嵌入
    .replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, "$2") // wikilink
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // md 链接/图片
    .replace(/^#{1,6}\s.*$/gm, "") // 标题行
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "") // 列表标记
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > maxLen ? text.slice(0, maxLen).trimEnd() + "…" : text
}

function toDateStr(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// ---------- 扫描 ----------

function collectMdFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMdFiles(full))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full)
  }
  return out
}

function readArticle(filePath, contentDir) {
  const raw = readFileSync(filePath, "utf8")
  const { fm, body } = splitFrontmatter(raw)
  const rel = filePath.slice(resolve(contentDir).length + 1)
  const fileName = rel.split(sep).pop().replace(/\.md$/i, "")
  const date =
    toDateStr(fm.created) ??
    toDateStr(fm.date) ??
    toDateStr(fm.sourcePublished) ??
    toDateStr(fm.sourceCreated) ??
    toDateStr(statSync(filePath).mtime)
  return {
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fileName,
    description:
      (typeof fm.description === "string" && fm.description.trim()) ||
      (typeof fm.sourceDescription === "string" && fm.sourceDescription.trim()) ||
      extractExcerpt(body),
    date,
    slug: slugifyMdPath(rel),
  }
}

// 扫描 content:返回 { featured: [...], sections: [{ num, name, articles }] }
export function scanContent(contentDir) {
  const featured = []
  const sections = []
  const topDirs = readdirSync(contentDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  for (const top of topDirs) {
    const topPath = join(contentDir, top)
    const entries = readdirSync(topPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "zh"),
    )
    for (const entry of entries) {
      const full = join(topPath, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        featured.push(readArticle(full, contentDir))
      } else if (entry.isDirectory()) {
        const files = collectMdFiles(full)
        if (files.length === 0) continue
        const articles = files
          .map((f) => readArticle(f, contentDir))
          .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
        sections.push({ ...splitOrderPrefix(entry.name), articles })
      }
    }
  }

  // featured 按文件名 NN 前缀排序并重编号展示
  featured.sort((a, b) => a.slug.localeCompare(b.slug))
  return { featured, sections }
}

// ---------- 渲染 ----------
// ⚠️ CommonMark 的 HTML 块在空行处中断,生成的每个顶层 HTML 块内部禁止空行。

function renderHero({ articleCount, sectionCount }) {
  const stats = [
    `<span class="home-stat"><b>${articleCount}</b> 篇笔记</span>`,
    `<span class="home-stat"><b>${sectionCount}</b> 个专题</span>`,
    `<span class="home-stat">每日自动同步</span>`,
  ].join("")
  return [
    `<header class="home-hero">`,
    `<p class="home-kicker">AI · Knowledge Base</p>`,
    `<h1 class="home-title">AI 知识库<span class="home-dot">。</span></h1>`,
    `<p class="home-tagline">AI 工具、Claude Code 与智能体工程的学习笔记与精选文章,从 Obsidian 知识库自动同步,持续更新。</p>`,
    `<p class="home-stats">${stats}</p>`,
    `</header>`,
  ].join("\n")
}

function renderFeatured(featured) {
  if (featured.length === 0) return null
  const items = featured.map((a, i) => {
    const { num, name } = splitOrderPrefix(a.title)
    const no = num ?? String(i + 1).padStart(2, "0")
    return [
      `<li class="home-toc-item"><a href="/${a.slug}" data-no-popover="true">`,
      `<span class="home-toc-num">${escapeHtml(no)}</span>`,
      `<span class="home-toc-text"><span class="home-toc-title">${escapeHtml(name)}</span>`,
      `<span class="home-toc-desc">${escapeHtml(a.description)}</span></span>`,
      `<span class="home-toc-arrow" aria-hidden="true">→</span>`,
      `</a></li>`,
    ].join("")
  })
  return [
    `<section class="home-block home-featured">`,
    `<h2 class="home-block-label">精选指南</h2>`,
    `<ol class="home-toc">`,
    ...items,
    `</ol>`,
    `</section>`,
  ].join("\n")
}

function renderSection(section, idx) {
  const no = String(idx + 1).padStart(2, "0")
  // ⚠️ <a> 内只能放行内元素(span):HTML 解析器会把 a 内的 h3/p 容错拆分成多个 a
  const cards = section.articles.map(
    (a) =>
      [
        `<a class="home-card" href="/${a.slug}" data-no-popover="true">`,
        `<span class="home-card-title">${escapeHtml(a.title)}</span>`,
        `<span class="home-card-desc">${escapeHtml(a.description)}</span>`,
        a.date
          ? `<span class="home-card-meta">${a.date}</span>`
          : `<span class="home-card-meta"></span>`,
      ].join("") + `</a>`,
  )
  return [
    `<section class="home-block home-section">`,
    `<header class="home-sec-head">`,
    `<span class="home-sec-num">${no}</span>`,
    `<h2 class="home-sec-title">${escapeHtml(section.name)}</h2>`,
    `<span class="home-sec-count">${section.articles.length} 篇</span>`,
    `</header>`,
    `<div class="home-grid">`,
    ...cards,
    `</div>`,
    `</section>`,
  ].join("\n")
}

export function renderHome({ featured, sections }) {
  const articleCount = featured.length + sections.reduce((n, s) => n + s.articles.length, 0)
  const blocks = [
    renderHero({ articleCount, sectionCount: sections.length }),
    renderFeatured(featured),
    ...sections.map((s, i) => renderSection(s, i)),
  ].filter(Boolean)
  const frontmatter = [
    `---`,
    `title: AI 知识库`,
    `description: AI 工具、Claude Code 与智能体工程的学习笔记与精选文章,从 Obsidian 知识库自动同步,持续更新。`,
    `cssclasses:`,
    `  - home`,
    `---`,
  ].join("\n")
  // 块之间空一行(分隔 HTML block),块内部无空行
  return frontmatter + "\n\n" + blocks.join("\n\n") + "\n"
}

// ---------- 入口 ----------

function main() {
  const contentDir = resolve(process.argv[2] ?? "content")
  if (!existsSync(contentDir)) {
    console.error(`[generate-home] 目录不存在: ${contentDir}`)
    process.exit(1)
  }
  const data = scanContent(contentDir)
  const total = data.featured.length + data.sections.reduce((n, s) => n + s.articles.length, 0)
  if (total === 0) {
    // 内容未拉取(裸构建):保留仓库里的 index.md,不生成空首页
    console.log(`[generate-home] 未发现文章,保持 index.md 原样`)
    return
  }
  const out = join(contentDir, "index.md")
  writeFileSync(out, renderHome(data), "utf8")
  console.log(
    `[generate-home] 已生成首页: ${total} 篇(精选 ${data.featured.length} + ${data.sections.length} 个专题)→ ${out}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
