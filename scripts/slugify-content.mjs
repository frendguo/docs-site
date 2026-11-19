#!/usr/bin/env node
// 内容 URL 英文短 slug 化工具
// 在 adapt-obsidian.mjs 之后、generate-home.mjs 与 `quartz build` 之前运行。
//
// 核心能力:
//   1. 剥离顶层套壳目录(默认 "1 - AI"),输出干净两级英文路径: <topic-slug>/<article-slug>.md
//   2. 已在 data/slug-map.json 记录的目录/文章直接复用(0 次 API 调用,URL 永久稳定)
//   3. 支持 rclone lsjson 导出的 driveId:改标题/挪目录时自动沿用旧 slug 并记录 301 历史
//   4. 仅对新文章/新中文目录批量调用 DeepSeek 生成 2~5 词英文短 slug,持久化到 slug-map.json
//   5. 无 API Key 或接口异常时降级为 ASCII/8 位短 hash 兜底(不写入 slug-map.json,不阻塞构建)
//   6. 两遍扫描改写正文与 frontmatter 内的 [[wikilink]]、Markdown 链接及相对图片路径,补全缺失 title
//   7. 为每个专题目录生成带中文 title 的 index.md(保持面包屑/侧边栏/首页中文名)
//   8. 生成 Cloudflare Pages _redirects(301 永久重定向,兼容所有旧长链接与 history)
//
// 用法:
//   node scripts/slugify-content.mjs [contentDir] [options]
//   --map <path>             slug 映射表路径(默认 data/slug-map.json)
//   --strip-root <name>      剥离的顶层目录名(默认 "1 - AI")
//   --drive-manifest <path>  rclone lsjson 导出的清单 JSON(可选,用于 driveId 跟踪)
//   --redirects-out <path>   Cloudflare Pages _redirects 输出路径(可选)
//   --no-write-map           不把新增映射写回 slug-map.json(本地预览/干跑用)

import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

const DEFAULT_MAP_PATH = "data/slug-map.json"
const DEFAULT_STRIP_ROOT = "1 - AI"
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"
const DEFAULT_IGNORE_PATTERNS = new Set(["private", "templates", ".obsidian"])
const RESERVED_ROOT_SLUGS = new Set(["index", "tags"])
const DEEPSEEK_BATCH_SIZE = 25
const MAX_SLUG_LEN = 48

// ---------- 通用纯函数 ----------

export function toPosix(p) {
  return String(p).replace(/\\/g, "/")
}

export function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { fm: {}, fmRaw: null, body: raw, eol: raw.includes("\r\n") ? "\r\n" : "\n" }
  let fm
  try {
    fm = parseYaml(m[1]) ?? {}
  } catch {
    fm = {}
  }
  return {
    fm: typeof fm === "object" && fm !== null ? fm : {},
    fmRaw: m[1],
    body: raw.slice(m[0].length),
    eol: m[0].includes("\r\n") ? "\r\n" : "\n",
  }
}

export function splitOrderPrefix(name) {
  const m = name.match(/^(\d+)\s*-\s*(.+)$/)
  return m ? { num: m[1], name: m[2].trim() } : { num: null, name: name.trim() }
}

// 与 @quartz-community/utils slugifyPath 保持一致(用于生成旧 URL 301 源路径)
export function quartzSlugifySegment(s) {
  return s
    .replace(/\s/g, "-")
    .replace(/&/g, "-and-")
    .replace(/%/g, "-percent")
    .replace(/\?/g, "")
    .replace(/#/g, "")
    .toLowerCase()
}

export function quartzSlugifyMdPath(relPath) {
  return toPosix(relPath)
    .split("/")
    .map((seg) => quartzSlugifySegment(seg.replace(/\.md$/i, "")))
    .join("/")
}

export function sanitizeSlug(raw, maxLen = MAX_SLUG_LEN) {
  if (typeof raw !== "string") return ""
  let slug = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")

  if (slug.length > maxLen) {
    const cut = slug.slice(0, maxLen)
    const lastDash = cut.lastIndexOf("-")
    slug = (lastDash >= 12 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "")
  }
  return slug
}

export function isPureAscii(str) {
  return /^[\x20-\x7e]+$/.test(str)
}

export function fallbackHashSlug(input, prefix = "p") {
  const hash = createHash("sha256").update(String(input)).digest("hex").slice(0, 8)
  return `${prefix}-${hash}`
}

export function isDraftOrIgnored(fm, relPath, ignorePatterns = DEFAULT_IGNORE_PATTERNS) {
  if (fm?.draft === true || String(fm?.draft).toLowerCase() === "true") return true
  const parts = toPosix(relPath).split("/")
  return parts.some((p) => ignorePatterns.has(p))
}

function yamlQuote(str) {
  return JSON.stringify(String(str))
}

// 确保重命名后的 Markdown 在 frontmatter 中带有 title,避免 Quartz 回退到英文文件名作为 H1
export function ensureFrontmatterTitle(raw, fallbackTitle) {
  const { fm, fmRaw, body, eol } = splitFrontmatter(raw)
  if (typeof fm.title === "string" && fm.title.trim() !== "") return raw
  const titleLine = `title: ${yamlQuote(fallbackTitle)}`
  if (fmRaw === null) {
    return `---${eol}${titleLine}${eol}---${eol}${eol}${body}`
  }
  const nextFm = fmRaw.trim() === "" ? titleLine : `${titleLine}${eol}${fmRaw}`
  return `---${eol}${nextFm}${eol}---${eol}${body}`
}

// ---------- 链接改写 ----------

const IMAGE_OR_ASSET_EXT =
  /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico|pdf|mp4|webm|mov|mp3|wav|ogg|canvas|excalidraw|base)$/i

// 标点与空白归一化:容忍笔记双链里全角/半角标点差异(如 : vs ：、, vs ，)
export function normalizeLooseKey(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\-_:：,，.。;；!！?？()（）[\]【】「」『』"'“”‘’`]+/g, "")
}

function buildLinkIndex(entries) {
  const byOldRelNoExt = new Map()
  const byOldSubPathNoExt = new Map()
  const byOldQuartzSlug = new Map()
  const byOldStem = new Map()
  const byOldStemSlug = new Map()
  const byTitle = new Map()
  const byLooseKey = new Map()

  const addMulti = (map, key, entry) => {
    if (!key) return
    const list = map.get(key)
    if (list) {
      if (!list.includes(entry)) list.push(entry)
    } else {
      map.set(key, [entry])
    }
  }

  for (const entry of entries) {
    const oldNoExt = entry.oldRelPath.replace(/\.md$/i, "")
    byOldRelNoExt.set(oldNoExt.toLowerCase(), entry)

    if (entry.oldRelWithoutStripRoot) {
      const subNoExt = entry.oldRelWithoutStripRoot.replace(/\.md$/i, "")
      byOldSubPathNoExt.set(subNoExt.toLowerCase(), entry)
    }

    byOldQuartzSlug.set(entry.oldQuartzSlug.toLowerCase(), entry)
    addMulti(byOldStem, entry.oldStem.toLowerCase(), entry)
    addMulti(byOldStemSlug, quartzSlugifySegment(entry.oldStem).toLowerCase(), entry)
    addMulti(byLooseKey, normalizeLooseKey(entry.oldStem), entry)

    const fmTitle = typeof entry.fm?.title === "string" ? entry.fm.title.trim() : ""
    if (fmTitle) {
      addMulti(byTitle, fmTitle.toLowerCase(), entry)
      addMulti(byLooseKey, normalizeLooseKey(fmTitle), entry)
    }
  }

  return {
    byOldRelNoExt,
    byOldSubPathNoExt,
    byOldQuartzSlug,
    byOldStem,
    byOldStemSlug,
    byTitle,
    byLooseKey,
  }
}

function pickBestCandidate(candidates, sourceEntry) {
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]
  if (sourceEntry) {
    const sameFolder = candidates.find((c) => c.oldDir === sourceEntry.oldDir)
    if (sameFolder) return sameFolder
  }
  return [...candidates].sort((a, b) => a.newQuartzSlug.localeCompare(b.newQuartzSlug))[0]
}

function resolveRenameTarget(rawTarget, sourceEntry, linkIndex) {
  const cleaned = toPosix(rawTarget)
    .trim()
    .replace(/^\.?\//, "")
    .replace(/\.md$/i, "")
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()

  const direct =
    linkIndex.byOldRelNoExt.get(lower) ??
    linkIndex.byOldSubPathNoExt.get(lower) ??
    linkIndex.byOldQuartzSlug.get(lower)
  if (direct) return direct

  if (cleaned.includes("/")) {
    const slugged = cleaned
      .split("/")
      .map((s) => quartzSlugifySegment(s))
      .join("/")
      .toLowerCase()
    const bySlug = linkIndex.byOldQuartzSlug.get(slugged)
    if (bySlug) return bySlug
    // 允许相对于 stripRoot 的路径(如 00 - Agent/xxx → 1---ai/00---agent/xxx)
    for (const [k, v] of linkIndex.byOldSubPathNoExt.entries()) {
      if (
        k
          .split("/")
          .map((s) => quartzSlugifySegment(s))
          .join("/") === slugged
      ) {
        return v
      }
    }
    return null
  }

  return (
    pickBestCandidate(linkIndex.byOldStem.get(lower), sourceEntry) ??
    pickBestCandidate(linkIndex.byOldStemSlug.get(quartzSlugifySegment(cleaned)), sourceEntry) ??
    pickBestCandidate(linkIndex.byTitle?.get(lower), sourceEntry) ??
    pickBestCandidate(linkIndex.byLooseKey?.get(normalizeLooseKey(cleaned)), sourceEntry)
  )
}

function rewriteWikilinkMatch(fullMatch, bang, inner, sourceEntry, linkIndex) {
  // 处理表格中转义的 \| 或普通 |
  let targetPart = inner
  let pipeSep = ""
  let aliasPart = ""
  const escPipeIdx = inner.indexOf("\\|")
  const rawPipeIdx = inner.indexOf("|")
  if (escPipeIdx !== -1 && (rawPipeIdx === -1 || escPipeIdx < rawPipeIdx)) {
    targetPart = inner.slice(0, escPipeIdx)
    pipeSep = "\\|"
    aliasPart = inner.slice(escPipeIdx + 2)
  } else if (rawPipeIdx !== -1) {
    targetPart = inner.slice(0, rawPipeIdx)
    pipeSep = "|"
    aliasPart = inner.slice(rawPipeIdx + 1)
  }

  let filePart = targetPart
  let anchorPart = ""
  const hashIdx = targetPart.indexOf("#")
  if (hashIdx !== -1) {
    filePart = targetPart.slice(0, hashIdx)
    anchorPart = targetPart.slice(hashIdx)
  }

  if (!filePart.trim() || IMAGE_OR_ASSET_EXT.test(filePart.trim())) {
    return fullMatch
  }

  const matched = resolveRenameTarget(filePart, sourceEntry, linkIndex)
  if (!matched) return fullMatch

  if (bang === "!") {
    // 嵌入笔记 ![[note]] 不需要追加显示别名
    const suffix = pipeSep ? `${pipeSep}${aliasPart}` : ""
    return `![[${matched.newQuartzSlug}${anchorPart}${suffix}]]`
  }

  // 无显式别名时保留原中文显示名,避免页面上露出英文 slug
  const displayAlias = pipeSep ? aliasPart : filePart.trim().replace(/\.md$/i, "").split("/").pop()
  const sep = pipeSep || "|"
  return `[[${matched.newQuartzSlug}${anchorPart}${sep}${displayAlias}]]`
}

function rewriteMarkdownHref(href, sourceEntry, linkIndex) {
  const trimmed = href.trim()
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.startsWith("//")
  ) {
    return href
  }

  const hashIdx = trimmed.indexOf("#")
  const rawPath = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
  const anchor = hashIdx === -1 ? "" : trimmed.slice(hashIdx)
  if (!rawPath) return href

  let decoded
  try {
    decoded = decodeURI(rawPath)
  } catch {
    decoded = rawPath
  }

  // 解析相对路径为旧 content 根下的 POSIX 路径
  const resolvedOld = decoded.startsWith("/")
    ? decoded.slice(1)
    : posix.normalize(posix.join(sourceEntry.oldDir === "." ? "" : sourceEntry.oldDir, decoded))

  const matched =
    resolveRenameTarget(resolvedOld, sourceEntry, linkIndex) ??
    resolveRenameTarget(decoded, sourceEntry, linkIndex)
  if (matched) {
    return `/${matched.newQuartzSlug}${anchor}`
  }

  // 非 md 资源(如 ../../99 - images/foo.png):若源目录层级变化,重新计算相对路径
  if (!decoded.startsWith("/") && sourceEntry.oldDir !== sourceEntry.newDir) {
    const newFrom = sourceEntry.newDir === "." ? "" : sourceEntry.newDir
    const rel = posix.relative(newFrom, resolvedOld)
    const encoded = rel
      .split("/")
      .map((seg) => encodeURI(seg))
      .join("/")
    return `${encoded}${anchor}`
  }

  return href
}

export function rewriteLinksInMarkdown(raw, sourceEntry, linkIndex) {
  const { fmRaw, body, eol } = splitFrontmatter(raw)

  // 1) 重写 frontmatter 里的 [[wikilink]](例如 translation: "[[原文章]]")
  const nextFmRaw =
    fmRaw === null
      ? null
      : fmRaw.replace(/(!?)\[\[([^\]]+)\]\]/g, (m, bang, inner) =>
          rewriteWikilinkMatch(m, bang, inner, sourceEntry, linkIndex),
        )

  // 2) 重写正文,保护围栏代码块与行内代码
  const slots = []
  const stash = (text, re) => text.replace(re, (m) => `@@SLGSLOT_${slots.push(m) - 1}@@`)

  let nextBody = body
  nextBody = stash(nextBody, /```[\s\S]*?```/g)
  nextBody = stash(nextBody, /~~~[\s\S]*?~~~/g)
  nextBody = stash(nextBody, /`[^`\n]+`/g)

  nextBody = nextBody.replace(/(!?)\[\[([^\]]+)\]\]/g, (m, bang, inner) =>
    rewriteWikilinkMatch(m, bang, inner, sourceEntry, linkIndex),
  )

  nextBody = nextBody.replace(
    /(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g,
    (m, prefix, url, suffix) => {
      const nextUrl = rewriteMarkdownHref(url, sourceEntry, linkIndex)
      return nextUrl === url ? m : `${prefix}${nextUrl}${suffix}`
    },
  )

  nextBody = nextBody.replace(/@@SLGSLOT_(\d+)@@/g, (_, i) => slots[Number(i)])

  if (nextFmRaw === null) return nextBody
  return `---${eol}${nextFmRaw}${eol}---${eol}${nextBody}`
}

// ---------- DeepSeek API ----------

function parseJsonLoose(text) {
  const trimmed = String(text ?? "").trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1] : trimmed)
}

export async function callDeepSeekBatch(items, config = {}, fetchImpl = globalThis.fetch) {
  const result = new Map()
  if (!items || items.length === 0) return result

  const apiKey = config.apiKey ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) return result

  const baseUrl = (
    config.baseUrl ??
    process.env.DEEPSEEK_BASE_URL ??
    DEFAULT_DEEPSEEK_BASE_URL
  ).replace(/\/+$/, "")
  const model = config.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL
  const batchSize = config.batchSize ?? DEEPSEEK_BATCH_SIZE

  const systemPrompt = [
    "You generate short, clean, SEO-friendly English URL slugs for an AI engineering knowledge base.",
    'Return ONLY a valid JSON object of the form {"slugs": {"<id>": "<slug>"}}.',
    "Rules:",
    "- Use lowercase ASCII letters, digits, and single hyphens only (^[a-z0-9]+(?:-[a-z0-9]+)*$).",
    "- For articles: 2 to 5 concise words, max 48 characters.",
    "- For folders: 1 to 2 concise words, max 24 characters.",
    "- Preserve well-known proper nouns (claude-code, manus, codex, mcp, adk, raycast, grok, langchain, harness, kv-cache, llm, ai, cli, skill).",
    "- When an article is inside a topic folder (e.g. folder 'claude-code'), avoid repeating the folder prefix unless needed for clarity (e.g. 'Claude Code 团队如何做代码评审' in folder 'claude-code' -> 'team-code-review').",
    "- Do not include numbering prefixes like '00-' or '01-'.",
    "- Every input id must appear in the returned slugs object.",
  ].join("\n")

  const totalBatches = Math.ceil(items.length / batchSize)
  console.log(
    `[slugify-content] 调用 DeepSeek (${model}) 生成 ${items.length} 个英文 slug (共 ${totalBatches} 批)...`,
  )

  for (let b = 0; b < totalBatches; b++) {
    const chunk = items.slice(b * batchSize, (b + 1) * batchSize)
    const body = JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(chunk) },
      ],
    })

    let ok = false
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(config.timeoutMs ?? 45000),
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => "")
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`)
        }
        const json = await res.json()
        const content = json?.choices?.[0]?.message?.content
        const parsed = parseJsonLoose(content)
        const slugsObj = parsed?.slugs && typeof parsed.slugs === "object" ? parsed.slugs : parsed
        if (slugsObj && typeof slugsObj === "object") {
          for (const item of chunk) {
            const candidate = sanitizeSlug(
              slugsObj[item.id],
              item.type === "folder" ? 24 : MAX_SLUG_LEN,
            )
            if (candidate) result.set(item.id, candidate)
          }
          ok = true
        }
      } catch (err) {
        console.warn(
          `[slugify-content] DeepSeek 第 ${b + 1}/${totalBatches} 批(尝试 ${attempt}/2)失败: ${err.message}`,
        )
      }
    }
  }

  return result
}

// ---------- 映射表与文件扫描 ----------

export function loadSlugMap(mapPath) {
  if (!mapPath || !existsSync(mapPath)) {
    return { version: 1, folders: {}, articles: {} }
  }
  const raw = JSON.parse(readFileSync(mapPath, "utf8"))
  return {
    version: raw.version ?? 1,
    folders: typeof raw.folders === "object" && raw.folders !== null ? { ...raw.folders } : {},
    articles: typeof raw.articles === "object" && raw.articles !== null ? { ...raw.articles } : {},
  }
}

function saveSlugMap(mapPath, slugMap) {
  const sortedFolders = Object.fromEntries(
    Object.entries(slugMap.folders).sort(([a], [b]) => a.localeCompare(b, "zh")),
  )
  const sortedArticles = Object.fromEntries(
    Object.entries(slugMap.articles).sort(([a], [b]) => a.localeCompare(b, "zh")),
  )
  const out = { version: 1, folders: sortedFolders, articles: sortedArticles }
  mkdirSync(dirname(resolve(mapPath)), { recursive: true })
  writeFileSync(mapPath, JSON.stringify(out, null, 2) + "\n", "utf8")
}

function loadDriveManifest(manifestPath, stripRoot) {
  // 返回 Map<originalRelPath (如 "1 - AI/00 - Agent/xxx.md"), driveId>
  const map = new Map()
  if (!manifestPath || !existsSync(manifestPath)) return map
  try {
    const items = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (!Array.isArray(items)) return map
    for (const item of items) {
      if (!item || item.IsDir || !item.Path || !item.ID) continue
      const p = toPosix(item.Path).replace(/^\/+/, "")
      const fullRel = stripRoot ? `${stripRoot}/${p}` : p
      map.set(fullRel, String(item.ID))
    }
  } catch (err) {
    console.warn(`[slugify-content] 读取 drive-manifest 失败,跳过 driveId 匹配: ${err.message}`)
  }
  return map
}

function walkAllFiles(dir, baseDir = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkAllFiles(full, baseDir))
    } else if (entry.isFile()) {
      const rel = toPosix(full.slice(resolve(baseDir).length + 1))
      out.push({ full, rel })
    }
  }
  return out
}

function removeEmptyDirs(dir, isRoot = true) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      removeEmptyDirs(join(dir, entry.name), false)
    }
  }
  if (!isRoot && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true })
  }
}

function encodeRedirectPath(slugPath) {
  return (
    "/" +
    toPosix(slugPath)
      .replace(/^\/+/, "")
      .split("/")
      .map((seg) => encodeURI(seg))
      .join("/")
  )
}

export function buildRedirects({ stripRoot, folderRecords, articleEntries }) {
  const lines = []
  const seenFrom = new Set()
  const addRule = (fromSlug, toSlug) => {
    const from = encodeRedirectPath(fromSlug)
    const to = toSlug === "/" ? "/" : encodeRedirectPath(toSlug)
    if (from === to || seenFrom.has(from)) return
    seenFrom.add(from)
    lines.push(`${from} ${to} 301`)
  }

  if (stripRoot) {
    addRule(quartzSlugifySegment(stripRoot), "/")
  }

  for (const folder of folderRecords) {
    if (folder.oldQuartzSlug && folder.slug) {
      addRule(folder.oldQuartzSlug, folder.slug)
    }
  }

  for (const entry of articleEntries) {
    if (entry.isDraft) continue
    addRule(entry.oldQuartzSlug, entry.newQuartzSlug)
    for (const hist of entry.history ?? []) {
      addRule(hist, entry.newQuartzSlug)
    }
  }

  return lines.sort().join("\n") + (lines.length > 0 ? "\n" : "")
}

function allocateUniqueSlug(baseSlug, usedSet, fallbackSeed) {
  let candidate = sanitizeSlug(baseSlug) || fallbackHashSlug(fallbackSeed)
  if (!usedSet.has(candidate)) {
    usedSet.add(candidate)
    return candidate
  }
  let n = 2
  while (usedSet.has(`${candidate}-${n}`)) n++
  const unique = `${candidate}-${n}`
  usedSet.add(unique)
  return unique
}

// ---------- 主流程 ----------

export async function slugifyContent(options = {}) {
  const contentDir = resolve(options.contentDir ?? "content")
  const mapPath = options.mapPath ?? DEFAULT_MAP_PATH
  const stripRoot = options.stripRoot ?? DEFAULT_STRIP_ROOT
  const writeMap = options.writeMap ?? true
  const redirectsOut = options.redirectsOut ?? null
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const deepseekConfig = options.deepseekConfig ?? {}

  if (!existsSync(contentDir)) {
    throw new Error(`目录不存在: ${contentDir}`)
  }

  const allFiles = walkAllFiles(contentDir)
  const mdFiles = allFiles.filter(
    (f) => f.rel.toLowerCase().endsWith(".md") && f.rel.toLowerCase() !== "index.md",
  )

  // 幂等保护:若已处理过(无 stripRoot 目录且存在脚本生成的目录 index.md),直接跳过
  const hasStripRoot = stripRoot && existsSync(join(contentDir, stripRoot))
  if (!hasStripRoot) {
    const alreadySlugified = mdFiles.some((f) => {
      if (!f.rel.toLowerCase().endsWith("/index.md")) return false
      const { fm } = splitFrontmatter(readFileSync(f.full, "utf8"))
      return fm.generatedBy === "slugify-content"
    })
    if (alreadySlugified) {
      console.log("[slugify-content] 检测到内容目录已完成英文 slug 化,跳过重复执行")
      return { skipped: true, articles: 0, folders: 0, llmGenerated: 0, redirects: 0 }
    }
  }

  if (mdFiles.length === 0) {
    console.log("[slugify-content] 未发现文章,跳过")
    return { skipped: true, articles: 0, folders: 0, llmGenerated: 0, redirects: 0 }
  }

  const slugMap = loadSlugMap(mapPath)
  const driveIdByRel = loadDriveManifest(options.driveManifestPath, hasStripRoot ? stripRoot : "")
  let mapDirty = false

  // 构建 driveId → slugMap.articles key 反向索引
  const articleKeyByDriveId = new Map()
  for (const [key, val] of Object.entries(slugMap.articles)) {
    if (val && typeof val === "object" && val.driveId) {
      articleKeyByDriveId.set(val.driveId, key)
    }
  }

  // 1) 识别专题目录与文章列表
  const rawFolders = new Map() // origFolderName -> { origName, oldQuartzSlug, displayName, order }
  const parsedArticles = []
  const extraFilesInStripRoot = []

  for (const f of allFiles) {
    if (f.rel.toLowerCase().endsWith(".md")) continue
    if (hasStripRoot && f.rel.startsWith(`${stripRoot}/`)) {
      extraFilesInStripRoot.push(f)
    }
  }

  for (const f of mdFiles) {
    const raw = readFileSync(f.full, "utf8")
    const { fm } = splitFrontmatter(raw)
    const isDraft = isDraftOrIgnored(fm, f.rel, ignorePatterns)

    const inStripRoot = hasStripRoot && f.rel.startsWith(`${stripRoot}/`)
    const relWithoutStrip = inStripRoot ? f.rel.slice(stripRoot.length + 1) : f.rel
    const parts = relWithoutStrip.split("/")
    const fileName = parts.at(-1)
    const oldStem = fileName.replace(/\.md$/i, "")
    const origFolder = parts.length >= 2 ? parts[0] : null

    if (origFolder && !rawFolders.has(origFolder)) {
      const { name: cleanName } = splitOrderPrefix(origFolder)
      const oldFolderRel = inStripRoot ? `${stripRoot}/${origFolder}` : origFolder
      rawFolders.set(origFolder, {
        origName: origFolder,
        displayName: cleanName,
        oldQuartzSlug: quartzSlugifyMdPath(oldFolderRel),
        slug: null,
      })
    }

    // 规范化 canonicalKey(若在 stripRoot 下保留 stripRoot 前缀,与历史路径一致)
    const canonicalKey = f.rel
    const driveId = driveIdByRel.get(canonicalKey) ?? null

    parsedArticles.push({
      full: f.full,
      raw,
      fm,
      isDraft,
      oldRelPath: f.rel,
      oldRelWithoutStripRoot: inStripRoot ? relWithoutStrip : null,
      oldDir: posix.dirname(f.rel),
      oldStem,
      oldQuartzSlug: quartzSlugifyMdPath(f.rel),
      origFolder,
      canonicalKey,
      driveId,
      slug: null,
      source: null, // "frontmatter" | "map" | "deepseek" | "ascii" | "hash"
      history: [],
    })
  }

  // 目录按原名称排序(保证与旧 generate-home 专题顺序一致)
  const folderList = [...rawFolders.values()].sort((a, b) =>
    a.origName.localeCompare(b.origName, "zh"),
  )
  folderList.forEach((f, idx) => {
    f.sectionOrder = idx
  })

  // 2) 确定待调 DeepSeek 的目录和文章
  const llmRequests = []

  for (const folder of folderList) {
    const mapped = slugMap.folders[folder.origName]
    if (mapped && sanitizeSlug(mapped, 24)) {
      folder.slug = sanitizeSlug(mapped, 24)
      folder.source = "map"
    } else if (isPureAscii(folder.displayName) && sanitizeSlug(folder.displayName, 24)) {
      folder.slug = sanitizeSlug(folder.displayName, 24)
      folder.source = "ascii"
      slugMap.folders[folder.origName] = folder.slug
      mapDirty = true
    } else {
      llmRequests.push({
        id: `folder:${folder.origName}`,
        type: "folder",
        folder: "",
        title: folder.displayName,
      })
    }
  }

  for (const art of parsedArticles) {
    // 专题目录内自带的 index.md 保持为该目录的 index.md
    if (art.origFolder && art.oldStem.toLowerCase() === "index") {
      art.slug = "index"
      art.source = "index"
      continue
    }

    // 2.1 frontmatter 显式 slug 最高优先级
    if (typeof art.fm.slug === "string" && sanitizeSlug(art.fm.slug)) {
      art.slug = sanitizeSlug(art.fm.slug)
      art.source = "frontmatter"
      const existing = slugMap.articles[art.canonicalKey]
      if (existing?.history) art.history = [...existing.history]
      continue
    }

    // 2.2 精确路径匹配 slug-map.json
    const byKey = slugMap.articles[art.canonicalKey]
    if (byKey) {
      const savedSlug = typeof byKey === "string" ? byKey : byKey.slug
      if (sanitizeSlug(savedSlug)) {
        art.slug = sanitizeSlug(savedSlug)
        art.source = "map"
        art.history = Array.isArray(byKey.history) ? [...byKey.history] : []
        if (art.driveId && byKey.driveId !== art.driveId) {
          slugMap.articles[art.canonicalKey] = {
            slug: art.slug,
            driveId: art.driveId,
            ...(art.history.length > 0 ? { history: art.history } : {}),
          }
          mapDirty = true
        }
        continue
      }
    }

    // 2.3 driveId 匹配(文章在 Obsidian 中重命名或移动了专题目录)
    if (art.driveId && articleKeyByDriveId.has(art.driveId)) {
      const prevKey = articleKeyByDriveId.get(art.driveId)
      const prevRec = slugMap.articles[prevKey]
      const prevSlug = typeof prevRec === "string" ? prevRec : prevRec?.slug
      if (sanitizeSlug(prevSlug)) {
        art.slug = sanitizeSlug(prevSlug)
        art.source = "map"
        const history = new Set(Array.isArray(prevRec?.history) ? prevRec.history : [])
        // 记录移动前的旧完整 URL 以便 301 重定向
        const prevParts = prevKey
          .replace(hasStripRoot && prevKey.startsWith(`${stripRoot}/`) ? `${stripRoot}/` : "", "")
          .split("/")
        const prevFolderName = prevParts.length >= 2 ? prevParts[0] : null
        const prevFolderSlug = prevFolderName ? slugMap.folders[prevFolderName] : null
        const prevFinalSlug = prevFolderSlug ? `${prevFolderSlug}/${art.slug}` : art.slug
        history.add(prevFinalSlug)
        history.add(quartzSlugifyMdPath(prevKey))
        art.history = [...history]

        if (!art.isDraft) {
          delete slugMap.articles[prevKey]
          slugMap.articles[art.canonicalKey] = {
            slug: art.slug,
            driveId: art.driveId,
            history: art.history,
          }
          articleKeyByDriveId.set(art.driveId, art.canonicalKey)
          mapDirty = true
        }
        continue
      }
    }

    // 2.4 未命中映射:草稿直接用本地兜底,绝不发送给 API 或写入公开仓库
    if (art.isDraft) {
      const cleanStem = splitOrderPrefix(art.oldStem).name
      art.slug = isPureAscii(cleanStem)
        ? sanitizeSlug(cleanStem) || fallbackHashSlug(art.canonicalKey)
        : fallbackHashSlug(art.canonicalKey)
      art.source = "hash"
      continue
    }

    const folderHint = art.origFolder
      ? (rawFolders.get(art.origFolder)?.slug ?? art.origFolder)
      : ""
    const titleForLlm =
      typeof art.fm.title === "string" && art.fm.title.trim()
        ? art.fm.title.trim()
        : splitOrderPrefix(art.oldStem).name

    llmRequests.push({
      id: `article:${art.canonicalKey}`,
      type: "article",
      folder: folderHint,
      title: titleForLlm,
    })
  }

  // 3) 批量调用 DeepSeek(仅当有新项时)
  const llmResults =
    llmRequests.length > 0
      ? await callDeepSeekBatch(llmRequests, deepseekConfig, fetchImpl)
      : new Map()

  if (llmRequests.length > 0 && !(deepseekConfig.apiKey ?? process.env.DEEPSEEK_API_KEY)) {
    console.warn(
      `[slugify-content] 未设置 DEEPSEEK_API_KEY, ${llmRequests.length} 个新项临时使用兜底 slug(不会写入 ${mapPath})`,
    )
  }

  // 4) 分配最终唯一 slug(目录 & 文章)
  const usedFolderSlugs = new Set(RESERVED_ROOT_SLUGS)
  for (const folder of folderList) {
    if (!folder.slug) {
      const fromLlm = llmResults.get(`folder:${folder.origName}`)
      if (fromLlm) {
        folder.slug = allocateUniqueSlug(fromLlm, usedFolderSlugs, folder.origName)
        folder.source = "deepseek"
        slugMap.folders[folder.origName] = folder.slug
        mapDirty = true
      } else {
        folder.slug = allocateUniqueSlug(
          fallbackHashSlug(folder.origName, "topic"),
          usedFolderSlugs,
          folder.origName,
        )
        folder.source = "hash"
      }
    } else {
      folder.slug = allocateUniqueSlug(folder.slug, usedFolderSlugs, folder.origName)
    }
  }

  // 按目录隔离查重(根目录同时避开已占用的专题目录名与保留词)
  const usedByDir = new Map()
  usedByDir.set(".", new Set([...RESERVED_ROOT_SLUGS, ...usedFolderSlugs]))
  for (const folder of folderList) {
    usedByDir.set(folder.slug, new Set(["index"]))
  }

  let llmGenerated = 0
  let reusedCount = 0
  let frontmatterCount = 0
  let fallbackCount = 0

  // 先锁定已有映射和 frontmatter 指定的 slug,避免新文章抢占旧文章名字
  const orderedArticles = [...parsedArticles].sort((a, b) => {
    const rank = (x) => (x.source === "frontmatter" ? 0 : x.source === "map" ? 1 : 2)
    return rank(a) - rank(b) || a.canonicalKey.localeCompare(b.canonicalKey, "zh")
  })

  for (const art of orderedArticles) {
    const targetDir = art.origFolder ? rawFolders.get(art.origFolder).slug : "."
    const usedSet = usedByDir.get(targetDir)

    if (art.source === "index") {
      art.newDir = targetDir
      art.newRelPath = `${targetDir}/index.md`
      art.newQuartzSlug = `${targetDir}/index`
      continue
    }

    if (!art.slug) {
      const fromLlm = llmResults.get(`article:${art.canonicalKey}`)
      if (fromLlm) {
        art.slug = allocateUniqueSlug(fromLlm, usedSet, art.canonicalKey)
        art.source = "deepseek"
        llmGenerated++
        slugMap.articles[art.canonicalKey] = {
          slug: art.slug,
          ...(art.driveId ? { driveId: art.driveId } : {}),
        }
        mapDirty = true
      } else {
        const cleanStem = splitOrderPrefix(art.oldStem).name
        const asciiSlug = isPureAscii(cleanStem) ? sanitizeSlug(cleanStem) : ""
        art.slug = allocateUniqueSlug(
          asciiSlug || fallbackHashSlug(art.canonicalKey),
          usedSet,
          art.canonicalKey,
        )
        art.source = asciiSlug ? "ascii" : "hash"
        fallbackCount++
      }
    } else {
      const prevSlug = art.slug
      art.slug = allocateUniqueSlug(art.slug, usedSet, art.canonicalKey)
      if (art.slug !== prevSlug && art.source === "map" && !art.isDraft) {
        slugMap.articles[art.canonicalKey] = {
          slug: art.slug,
          ...(art.driveId ? { driveId: art.driveId } : {}),
          ...(art.history.length > 0 ? { history: art.history } : {}),
        }
        mapDirty = true
      }
      if (art.source === "frontmatter") frontmatterCount++
      else if (art.source === "map") reusedCount++
      else fallbackCount++
    }

    art.newDir = targetDir
    art.newRelPath = targetDir === "." ? `${art.slug}.md` : `${targetDir}/${art.slug}.md`
    art.newQuartzSlug = targetDir === "." ? art.slug : `${targetDir}/${art.slug}`
  }

  // 5) 两遍改写:改写链接 + 补全缺失 title
  const linkIndex = buildLinkIndex(orderedArticles)
  const rewrittenFiles = orderedArticles.map((art) => {
    const withTitle = ensureFrontmatterTitle(art.raw, art.oldStem)
    const withLinks = rewriteLinksInMarkdown(withTitle, art, linkIndex)
    return { art, content: withLinks }
  })

  // 6) 移动 stripRoot 内的非 md 附件(如有)
  for (const extra of extraFilesInStripRoot) {
    const relWithoutStrip = extra.rel.slice(stripRoot.length + 1)
    const parts = relWithoutStrip.split("/")
    let targetRel = relWithoutStrip
    if (parts.length >= 2 && rawFolders.has(parts[0])) {
      targetRel = [rawFolders.get(parts[0]).slug, ...parts.slice(1)].join("/")
    }
    const targetFull = join(contentDir, ...targetRel.split("/"))
    if (resolve(extra.full) !== resolve(targetFull)) {
      mkdirSync(dirname(targetFull), { recursive: true })
      renameSync(extra.full, targetFull)
    }
  }

  // 7) 删除旧 md 文件并写入新路径
  for (const art of orderedArticles) {
    if (existsSync(art.full)) unlinkSync(art.full)
  }
  for (const { art, content } of rewrittenFiles) {
    const targetFull = join(contentDir, ...art.newRelPath.split("/"))
    mkdirSync(dirname(targetFull), { recursive: true })
    writeFileSync(targetFull, content, "utf8")
  }

  // 8) 为每个专题目录生成带中文 title 的 index.md(若不存在)
  for (const folder of folderList) {
    const folderIndexPath = join(contentDir, folder.slug, "index.md")
    if (!existsSync(folderIndexPath)) {
      const idxContent = [
        "---",
        `title: ${yamlQuote(folder.displayName)}`,
        `sectionOrder: ${folder.sectionOrder}`,
        `generatedBy: slugify-content`,
        "---",
        "",
      ].join("\n")
      mkdirSync(dirname(folderIndexPath), { recursive: true })
      writeFileSync(folderIndexPath, idxContent, "utf8")
    }
  }

  // 清理遗留空目录(例如已搬空的 "1 - AI/")
  removeEmptyDirs(contentDir)

  // 9) 持久化 slug-map.json
  if (writeMap && mapDirty) {
    saveSlugMap(mapPath, slugMap)
    console.log(`[slugify-content] 已更新映射表 → ${mapPath}`)
  }

  // 10) 生成 Cloudflare Pages _redirects
  const redirectsText = buildRedirects({
    stripRoot: hasStripRoot ? stripRoot : null,
    folderRecords: folderList,
    articleEntries: orderedArticles,
  })
  const redirectCount = redirectsText ? redirectsText.trim().split("\n").length : 0
  if (redirectsOut) {
    mkdirSync(dirname(resolve(redirectsOut)), { recursive: true })
    writeFileSync(redirectsOut, redirectsText, "utf8")
    console.log(`[slugify-content] 已生成 ${redirectCount} 条 301 重定向 → ${redirectsOut}`)
  }

  console.log(
    `[slugify-content] 完成: ${orderedArticles.length} 篇文章, ${folderList.length} 个专题目录` +
      ` (复用 ${reusedCount}, DeepSeek 新增 ${llmGenerated}, frontmatter ${frontmatterCount}, 兜底 ${fallbackCount})`,
  )

  return {
    skipped: false,
    articles: orderedArticles.length,
    folders: folderList.length,
    reused: reusedCount,
    llmGenerated,
    frontmatter: frontmatterCount,
    fallback: fallbackCount,
    redirects: redirectCount,
    mapDirty,
  }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    contentDir: "content",
    mapPath: DEFAULT_MAP_PATH,
    stripRoot: DEFAULT_STRIP_ROOT,
    driveManifestPath: null,
    redirectsOut: null,
    writeMap: true,
  }
  let positionalSet = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--map") opts.mapPath = argv[++i]
    else if (arg === "--strip-root") opts.stripRoot = argv[++i]
    else if (arg === "--drive-manifest") opts.driveManifestPath = argv[++i]
    else if (arg === "--redirects-out") opts.redirectsOut = argv[++i]
    else if (arg === "--no-write-map") opts.writeMap = false
    else if (!arg.startsWith("-") && !positionalSet) {
      opts.contentDir = arg
      positionalSet = true
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  await slugifyContent(opts)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[slugify-content] 失败: ${err.message}`)
    process.exit(1)
  })
}
