# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

jackyzha0/quartz 的 fork（分支 v5，框架源码 vendored 在 `quartz/`），发布「AI 知识库」静态站到 Cloudflare Pages。正文内容**不在仓库里**：`content/*` 被 .gitignore 忽略（仅保留 index.md），CI 构建时才从 Google Drive 拉取；本地完整预览需从本地 Obsidian 库拷贝内容（用 `/preview` 技能）。

## 常用命令

- `npx quartz build --serve` — 本地构建并预览本站（**不要用 `npm run docs`**，那是构建 Quartz 自带文档目录 docs/）
- `npx quartz plugin install` — 按 quartz.lock.json 安装社区插件到 .quartz/plugins/，首次构建前必须先跑
- `npm run check` — tsc --noEmit + prettier 检查，提交前跑
- `npm run lint` — ESLint（本 fork 自加的 eslint.config.mjs；对上游 quartz/ 和根 \*.d.ts 关闭了其现存命中的风格类规则，scripts/ 和 .claude/ 自有代码全量严格；新增上游噪音时在配置里调规则，不要去改上游源码）
- `npm run format` — Prettier 全仓格式化
- 环境要求 Node >=22、npm >=10.9.2（.npmrc 开了 engine-strict）

## 构建管道（.github/workflows/deploy.yml）

CI 顺序：rclone 从 Google Drive 拉内容到 `content/1 - AI`、`content/99 - images` → `node scripts/adapt-obsidian.mjs`（修复 Obsidian 转义和伪标签，幂等可重跑）→ `sed -i '/content/d' .gitignore` → 装插件 → `npx quartz build` → `node scripts/trim-content-index.mjs`（搜索索引每篇截断到 2000 字）→ wrangler 部署 `public/` 到 Cloudflare Pages（项目 ai-knowledge-base）。

关键 gotcha：

- Quartz 的 globby 开了 `gitignore:true`（quartz/util/glob.ts），构建前必须临时解除 .gitignore 对 content 的忽略，否则只构建出首页 1 个页面（本地预览同理）。不要删掉或挪动 CI 里「Unignore pulled content」这一步
- 临时改过的 .gitignore 只存在于 runner/本地，绝不能把解除忽略后的 .gitignore 或拉取的内容提交进仓库

## 修改约定

- 本 fork 会持续同步上游 quartz，**尽量不改 `quartz/` 核心代码**；定制收敛到 `quartz/styles/custom.scss`、`quartz.config.yaml`、`scripts/`、`.github/workflows/deploy.yml`
- 组件是 Preact JSX（tsconfig `jsxImportSource: preact`），不是 React
- custom.scss 里部分 `!important` 是刻意压过主题/插件样式（内链去黄块、卡片圆角等），不要当冗余清理掉

## 提交与部署

- **推送 v5 分支 = 立即生产部署**（push 触发 deploy.yml；另有每日 UTC 19:00 定时同步内容）
- 约定攒批推送：本地可多次小提交，但推送前必须经用户确认（可用 `/ship` 技能走完整流程）
- 提交信息用中文「类别:简述」风格（如 `性能:…`、`样式修复:…`）
