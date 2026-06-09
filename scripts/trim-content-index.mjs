#!/usr/bin/env node
// 截断 contentIndex.json 的 content 字段,减小搜索索引体积、提速首屏。
//
// 背景: Quartz 把每篇文章全文塞进 public/static/contentIndex.json(供 flexsearch 全文搜索),
// 导致该文件占首屏下载的大头(本站 ~494KB,其中 93% 是全文)。explorer 文件树是 SSR 内联的,
// 不依赖此文件;文章页/悬浮预览读各自独立 HTML,也不读此文件。因此截断 content 只影响
// 搜索范围(标题/标签 + 正文前 N 字),不影响任何页面渲染。
//
// 用法: node scripts/trim-content-index.mjs [jsonPath] [limit]

import { readFileSync, writeFileSync, statSync } from "node:fs"

const PATH = process.argv[2] ?? "public/static/contentIndex.json"
const LIMIT = Number(process.argv[3] ?? 2000) // 每篇保留的正文字符数

const before = statSync(PATH).size
const idx = JSON.parse(readFileSync(PATH, "utf8"))
let trimmed = 0
const total = Object.keys(idx).length
for (const k of Object.keys(idx)) {
  const c = idx[k]?.content
  if (typeof c === "string" && c.length > LIMIT) {
    idx[k].content = c.slice(0, LIMIT)
    trimmed++
  }
}
writeFileSync(PATH, JSON.stringify(idx))
const after = statSync(PATH).size
console.log(
  `[trim-content-index] ${Math.round(before / 1024)}KB → ${Math.round(after / 1024)}KB` +
    ` (截断 ${trimmed}/${total} 篇,每篇保留前 ${LIMIT} 字)`,
)
