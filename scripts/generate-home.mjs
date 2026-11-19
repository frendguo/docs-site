#!/usr/bin/env node
// 首页生成器:扫描 content/ 把全部文章平铺为首页(content/index.md)
// 在 adapt-obsidian.mjs 之后、`quartz build` 之前运行。可重复运行(幂等):
// 产物完全由扫描结果决定,与 index.md 旧内容无关。
//
// 结构约定(与 CI 拉取结构一致):
//   content/<顶层目录>/<子目录>/**.md → 每个子目录一个专题分区(按日期倒序)
//   content/<顶层目录>/*.md          → 不上首页(原「精选指南」已移除),仍可经 Explorer/搜索访问
// 首页顺序:hero(搜索入口 + 专题导航)→ 最新更新(跨专题)→ 各专题分区。
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

const LATEST_COUNT = 8 // 「最新更新」条数
const SECTION_VISIBLE = 6 // 每个专题直接展示的卡片数,其余折叠进 <details>

const TAGLINE =
  "AI 工具、Claude Code 与智能体工程的学习笔记与精选文章,从 Obsidian 知识库自动同步,持续更新。"

// 首页大搜索框本身不是输入框:点击转发给 Quartz 搜索组件(顶栏 .search-button)唤起搜索弹窗
const SEARCH_ONCLICK = "document.querySelector('.search .search-button')?.click()"

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
  const fmDate =
    toDateStr(fm.created) ??
    toDateStr(fm.date) ??
    toDateStr(fm.sourcePublished) ??
    toDateStr(fm.sourceCreated)
  return {
    title: typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : fileName,
    description:
      (typeof fm.description === "string" && fm.description.trim()) ||
      (typeof fm.sourceDescription === "string" && fm.sourceDescription.trim()) ||
      extractExcerpt(body),
    // mtime 仅作展示兜底:adapt-obsidian.mjs 改写文件会刷新 mtime,不能参与「最新」判定
    date: fmDate ?? toDateStr(statSync(filePath).mtime),
    hasFmDate: fmDate != null,
    // 英文原文存档以 translation 字段指向其译文;最新区只展示译文,避免成对重复
    isOriginal: fm.translation != null && fm.translation !== "",
    slug: slugifyMdPath(rel),
  }
}

// 日期倒序,同日按 slug 保证产物稳定(幂等)
const byDateDesc = (a, b) =>
  (b.date ?? "").localeCompare(a.date ?? "") || a.slug.localeCompare(b.slug)

// 扫描 content:返回 { sections: [{ num, name, articles }] }
// 根级 md 不收录;整个专题都是英文原文时(原文存档)排到最后
export function scanContent(contentDir) {
  const sections = []
  const topDirs = readdirSync(contentDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  for (const top of topDirs) {
    const topPath = join(contentDir, top)
    const subDirs = readdirSync(topPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, "zh"))
    for (const entry of subDirs) {
      const files = collectMdFiles(join(topPath, entry.name))
      if (files.length === 0) continue
      const { num, name } = splitOrderPrefix(entry.name)
      const articles = files
        .map((f) => ({ ...readArticle(f, contentDir), section: name }))
        .sort(byDateDesc)
      sections.push({ num, name, articles })
    }
  }

  const isArchive = (s) => s.articles.every((a) => a.isOriginal)
  // Array.prototype.sort 稳定:非原文专题保持目录顺序
  sections.sort((a, b) => Number(isArchive(a)) - Number(isArchive(b)))
  return { sections }
}

// 跨专题取最新 n 篇:只收有 frontmatter 日期的译文/原创
export function pickLatest(sections, n = LATEST_COUNT) {
  return sections
    .flatMap((s) => s.articles)
    .filter((a) => a.hasFmDate && !a.isOriginal)
    .sort(byDateDesc)
    .slice(0, n)
}

// ---------- 渲染 ----------
// ⚠️ CommonMark 的 HTML 块在空行处中断,生成的每个顶层 HTML 块内部禁止空行。
// ⚠️ <a> 内只能放行内元素(span):HTML 解析器会把 a 内的 h3/p 容错拆分成多个 a

function renderHero({ articleCount, sections }) {
  const topics = sections.map(
    (s, i) =>
      `<a class="home-topic" href="#topic-${i + 1}" data-no-popover="true">${escapeHtml(s.name)}<span class="home-topic-count">${s.articles.length}</span></a>`,
  )
  return [
    `<header class="home-hero">`,
    `<p class="home-kicker">AI · Knowledge Base</p>`,
    `<h1 class="home-title">AI 知识库<span class="home-dot">。</span></h1>`,
    `<p class="home-tagline">${TAGLINE}</p>`,
    `<button type="button" class="home-search" aria-label="搜索全站文章" onclick="${SEARCH_ONCLICK}">`,
    `<svg class="home-search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="6.5"></circle><path d="M13.5 13.5 18 18"></path></svg>`,
    `<span class="home-search-text">搜索 ${articleCount} 篇笔记的标题、正文与标签…</span>`,
    `<kbd class="home-search-kbd">Ctrl K</kbd>`,
    `</button>`,
    `<nav class="home-topics" aria-label="专题导航">${topics.join("")}</nav>`,
    `</header>`,
  ].join("\n")
}

function renderLatest(latest) {
  if (latest.length === 0) return null
  const items = latest.map((a) =>
    [
      `<li class="home-latest-item"><a href="/${a.slug}" data-no-popover="true">`,
      `<span class="home-latest-date">${a.date}</span>`,
      `<span class="home-latest-text"><span class="home-latest-title">${escapeHtml(a.title)}</span>`,
      `<span class="home-latest-desc">${escapeHtml(a.description)}</span></span>`,
      `<span class="home-latest-tag">${escapeHtml(a.section)}</span>`,
      `</a></li>`,
    ].join(""),
  )
  return [
    `<section class="home-block home-latest">`,
    `<header class="home-sec-head">`,
    `<span class="home-sec-num">NEW</span>`,
    `<h2 class="home-sec-title">最新更新</h2>`,
    `</header>`,
    `<ol class="home-latest-list">`,
    ...items,
    `</ol>`,
    `</section>`,
  ].join("\n")
}

function renderCard(a) {
  return (
    [
      `<a class="home-card" href="/${a.slug}" data-no-popover="true">`,
      `<span class="home-card-title">${escapeHtml(a.title)}</span>`,
      `<span class="home-card-desc">${escapeHtml(a.description)}</span>`,
      `<span class="home-card-meta">${a.date ?? ""}</span>`,
    ].join("") + `</a>`
  )
}

function renderSection(section, idx) {
  const no = String(idx + 1).padStart(2, "0")
  const visible = section.articles.slice(0, SECTION_VISIBLE)
  const rest = section.articles.slice(SECTION_VISIBLE)
  const lines = [
    `<section class="home-block home-section" id="topic-${idx + 1}">`,
    `<header class="home-sec-head">`,
    `<span class="home-sec-num">${no}</span>`,
    `<h2 class="home-sec-title">${escapeHtml(section.name)}</h2>`,
    `<span class="home-sec-count">${section.articles.length} 篇</span>`,
    `</header>`,
    `<div class="home-grid">`,
    ...visible.map(renderCard),
    `</div>`,
  ]
  if (rest.length > 0) {
    lines.push(
      `<details class="home-more">`,
      `<summary class="home-more-toggle">展开其余 ${rest.length} 篇</summary>`,
      `<div class="home-grid">`,
      ...rest.map(renderCard),
      `</div>`,
      `</details>`,
    )
  }
  lines.push(`</section>`)
  return lines.join("\n")
}

export function renderHome({ sections }) {
  const articleCount = sections.reduce((n, s) => n + s.articles.length, 0)
  const blocks = [
    renderHero({ articleCount, sections }),
    renderLatest(pickLatest(sections)),
    ...sections.map((s, i) => renderSection(s, i)),
  ].filter(Boolean)
  const frontmatter = [
    `---`,
    `title: AI 知识库`,
    `description: ${TAGLINE}`,
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
  const total = data.sections.reduce((n, s) => n + s.articles.length, 0)
  if (total === 0) {
    // 内容未拉取(裸构建):保留仓库里的 index.md,不生成空首页
    console.log(`[generate-home] 未发现文章,保持 index.md 原样`)
    return
  }
  const out = join(contentDir, "index.md")
  writeFileSync(out, renderHome(data), "utf8")
  console.log(
    `[generate-home] 已生成首页: ${total} 篇(${data.sections.length} 个专题,最新 ${pickLatest(data.sections).length} 篇)→ ${out}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
