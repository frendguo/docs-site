#!/usr/bin/env node
// 构建后补丁:向 public/postscript*.js 追加极小的客户端体验修复(不改动上游 quartz/ 与社区插件源码)。
//
// 修复两个实测问题:
//   1. SPA 遇到 301 重定向(如旧标签页点旧 /1---ai/... 链接)时,Quartz 上游 spa.inline.ts 仍按旧路径
//      rebase 相对链接导致反向链接 404、且内存里的旧 contentIndex 让左侧 Explorer 选不中当前项。
//      此处在 nav 事件中比对 body.dataset.slug 与 location.pathname,不一致时自动 replace 到规范短 URL。
//   2. 跨专题切换文章时,Explorer 上游用 sessionStorage.explorerScrollTop 覆盖了 scrollIntoView(),
//      导致当前 .active 高亮项停在侧栏可视区外(看起来像未选中)。此处在 Explorer 渲染完成后确保
//      .active 所在文件夹展开且滚动到可视区内,并清理旧版 1---ai 的 localStorage.fileTree 残留。
//
// 用法: node scripts/patch-postscript.mjs [publicDir]   (默认 public)

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const MARKER = "/* __PATCH_POSTSCRIPT_V1__ */"

export const RUNTIME_SNIPPET = `
${MARKER}
;(() => {
  try {
    const raw = localStorage.getItem("fileTree")
    if (raw && raw.includes("1---ai")) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter((item) => item && typeof item.path === "string" && !item.path.startsWith("1---ai"))
        localStorage.setItem("fileTree", JSON.stringify(cleaned))
      }
    }
  } catch {}

  const norm = (p) => {
    let s = String(p || "").trim()
    try {
      s = decodeURIComponent(s)
    } catch {}
    s = s.replace(/^\\/+|\\/+$/g, "").replace(/\\.html$/i, "")
    if (s === "index") return ""
    return s.replace(/\\/index$/i, "").toLowerCase()
  }

  const syncCanonicalUrl = () => {
    const slug = document.body?.dataset?.slug
    if (!slug || slug === "404") return false
    const basePath = (document.body?.dataset?.basepath || "").replace(/\\/+$/, "")
    let pathname = location.pathname
    if (basePath && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length)
    }
    const normSlug = norm(slug)
    const normPath = norm(pathname)
    if (normPath !== normSlug) {
      const targetPath = slug === "index" ? "/" : slug.endsWith("/index") ? "/" + slug.slice(0, -5) : "/" + slug
      location.replace(basePath + targetPath + location.search + location.hash)
      return true
    }
    return false
  }

  const ensureExplorerActiveVisible = (ul) => {
    if (!ul) return false
    const slug = document.body?.dataset?.slug
    if (!slug || slug === "index" || slug === "404") return false
    let active = ul.querySelector("a.active")
    if (!active) {
      const targetNorm = norm(slug)
      for (const a of ul.querySelectorAll("a[href]")) {
        try {
          const p = norm(new URL(a.href, location.origin).pathname)
          if (p === targetNorm) {
            a.classList.add("active", "is-active")
            active = a
            break
          }
        } catch {}
      }
    }
    if (!active) return false
    let folder = active.closest(".folder-outer")
    while (folder) {
      folder.classList.add("open")
      folder = folder.parentElement?.closest(".folder-outer")
    }
    const aRect = active.getBoundingClientRect()
    const uRect = ul.getBoundingClientRect()
    if (aRect.height > 0 && uRect.height > 0 && (aRect.top < uRect.top || aRect.bottom > uRect.bottom)) {
      active.scrollIntoView({ block: "center", behavior: "instant" })
    }
    return true
  }

  const watchExplorer = () => {
    if (syncCanonicalUrl()) return
    const uls = document.querySelectorAll(".explorer-ul")
    for (const ul of uls) {
      let done = false
      const run = () => {
        if (done) return
        if (ul.querySelector("a")) {
          done = true
          obs.disconnect()
          requestAnimationFrame(() => ensureExplorerActiveVisible(ul))
        }
      }
      const obs = new MutationObserver(run)
      obs.observe(ul, { childList: true, subtree: true })
      requestAnimationFrame(run)
      setTimeout(() => obs.disconnect(), 4000)
    }
  }

  document.addEventListener("nav", watchExplorer)
  document.addEventListener("render", watchExplorer)
  if (document.readyState === "complete" || document.readyState === "interactive") {
    watchExplorer()
  }
})()
`

export function patchPostscript(publicDir = "public") {
  const dir = resolve(publicDir)
  if (!existsSync(dir)) {
    throw new Error(`目录不存在: ${dir}`)
  }
  const files = readdirSync(dir).filter((f) => /^postscript(?:-[a-f0-9]+)?\.js$/i.test(f))
  let patched = 0
  for (const name of files) {
    const full = join(dir, name)
    const before = readFileSync(full, "utf8")
    if (before.includes(MARKER)) continue
    writeFileSync(full, before + "\n" + RUNTIME_SNIPPET, "utf8")
    patched++
  }
  console.log(`[patch-postscript] 扫描 ${files.length} 个 postscript, 注入 ${patched} 个`)
  return { total: files.length, patched }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchPostscript(process.argv[2] ?? "public")
}
