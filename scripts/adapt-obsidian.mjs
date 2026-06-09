#!/usr/bin/env node
// Obsidian → Quartz 内容适配层
// 在 sync 拉取内容之后、`quartz build` 之前运行,修复 Obsidian 特有写法
// 在 Quartz 下导致的构建失败 / 渲染异常。可重复运行(幂等)。
//
// 用法: node scripts/adapt-obsidian.mjs [contentDir]   (默认 content)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const CONTENT_DIR = process.argv[2] ?? "content"

// 标准 HTML 标签白名单:在集合内的标签保留为真正的 HTML(如 <sup> <details> <br>),
// 其余形如 <name> <path> <your-token> 的"伪标签"视为占位符,转义为可见文本。
const HTML_TAGS = new Set([
  "a","abbr","address","area","article","aside","audio","b","base","bdi","bdo","blockquote",
  "body","br","button","canvas","caption","cite","code","col","colgroup","data","datalist","dd",
  "del","details","dfn","dialog","div","dl","dt","em","embed","fieldset","figcaption","figure",
  "footer","form","h1","h2","h3","h4","h5","h6","head","header","hgroup","hr","html","i","iframe",
  "img","input","ins","kbd","label","legend","li","link","main","map","mark","menu","meta","meter",
  "nav","noscript","object","ol","optgroup","option","output","p","param","picture","pre","progress",
  "q","rp","rt","ruby","s","samp","script","section","select","slot","small","source","span","strong",
  "style","sub","summary","sup","table","tbody","td","template","textarea","tfoot","th","thead","time",
  "title","tr","track","u","ul","var","video","wbr",
])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const fp = join(dir, name)
    const st = statSync(fp)
    if (st.isDirectory()) out.push(...walk(fp))
    else if (name.toLowerCase().endsWith(".md")) out.push(fp)
  }
  return out
}

function adapt(text) {
  // 1) 去掉 Obsidian 反斜杠转义尖括号(\< \>)。否则在表格/高亮嵌套下会残留为
  //    <name\> 这类含非法字符的标签,使 Quartz 的 JSX 渲染整体崩溃。
  text = text.replace(/\\([<>])/g, "$1")

  // 2) 保护代码区(围栏代码块 + 行内代码),避免下一步误伤代码内容。
  const slots = []
  const stash = (re) => {
    text = text.replace(re, (m) => `@@QZSLOT_${slots.push(m) - 1}@@`)
  }
  stash(/```[\s\S]*?```/g) // 围栏代码块
  stash(/`[^`\n]+`/g) // 行内代码

  // 3) 非代码区:把不在白名单内的伪标签转义为可见文本(<name> → &lt;name&gt;)。
  text = text.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\/?>/g,
    (m, tag) => (HTML_TAGS.has(tag.toLowerCase()) ? m : m.replace(/</g, "&lt;").replace(/>/g, "&gt;")),
  )

  // 4) 还原代码区。
  text = text.replace(/@@QZSLOT_(\d+)@@/g, (_, i) => slots[Number(i)])
  return text
}

const files = walk(CONTENT_DIR)
let changed = 0
for (const fp of files) {
  const before = readFileSync(fp, "utf8")
  const after = adapt(before)
  if (after !== before) {
    writeFileSync(fp, after, "utf8")
    changed++
  }
}
console.log(`[adapt-obsidian] 扫描 ${files.length} 个 Markdown,修改 ${changed} 个`)
