---
name: preview
description: 本地完整预览站点：从本地 Obsidian 库拷贝内容到 content/，跑 Obsidian 适配脚本，临时解除 .gitignore 对 content 的忽略后启动 quartz 本地服务，看完自动清理现场。当用户想在推送部署前看到改动的真实效果时使用——包括「本地预览」「起个服务看看」「看看样式/配色/卡片改完什么效果」「验证配置改动」「完整跑一下站点」等说法，即使没明说 preview 也应使用本技能（直接 quartz build --serve 只会构建出首页 1 个页面，必须走本流程）。
---

本地完整预览本站。仓库里 `content/*` 被 .gitignore 忽略，而 Quartz 的 globby 开了 `gitignore:true`，所以不走本流程的话只能构建出首页——这就是本技能存在的原因。

Obsidian 库路径：优先用 `$ARGUMENTS`；没传则询问用户本地 Obsidian 库路径。

## 步骤

1. **前置检查**
   - `node_modules` 不存在则先 `npm ci`
   - `.quartz/plugins` 不存在则先 `npx quartz plugin install`
   - `git status --porcelain .gitignore` 检查：若有改动且 diff 恰好是「content 相关行被删」，说明是上次预览未清理的残留，告知用户后可直接复用该状态继续；若是其他改动，停下来报告，不要覆盖用户的修改

2. **拷贝内容**（PowerShell 用 robocopy）
   - 若库内有 `1 - AI`、`99 - images` 等与 CI 拉取结构同名的目录，按原名拷到 `content/` 下；否则把整个库拷到 `content/` 下
   - 排除 `.obsidian`、`.trash`、`private`、`templates` 目录
   - ⚠️ robocopy 退出码 0–7 都是成功（1=有文件被拷贝），不要按「非零即失败」判断
   - 只改 content/ 里的副本，**绝不修改 Obsidian 库原文件**

3. **适配 Obsidian 语法**：`node scripts/adapt-obsidian.mjs`（幂等，只作用于 content/ 副本）

3b. **生成平铺首页**：`node scripts/generate-home.mjs`（扫描 content/ 覆盖 content/index.md，幂等；index.md 是 git 跟踪文件，清理阶段必须还原）

4. **临时解除 content 忽略**：删除 `.gitignore` 中所有包含 `content` 的行（与 CI 的 `sed -i '/content/d' .gitignore` 等价，共 4 行：1 行注释 + `content/*` + `!content/.gitkeep` + `!content/index.md`）
   - ⚠️ 此状态下**严禁执行 git add / git commit**，拷贝的内容和改过的 .gitignore 都不能进仓库

5. **启动预览**：`npx quartz build --serve`（后台运行），告知用户访问 http://localhost:8080，等待用户验证
   - --serve 带热重载，改 custom.scss / quartz.config.yaml 会自动重建，可以连续迭代样式
   - 8080 被占用时加 `--port <其他端口>` 重启

6. **清理（用户确认看完后必须执行）**
   - 停掉预览服务
   - `git restore .gitignore`
   - `git restore content/index.md`（generate-home.mjs 生成的首页只该存在于 runner/本地预览）
   - `git clean -fdX content/`（只删被忽略的拷贝内容；被跟踪的 index.md、.gitkeep 不受影响）
   - 用 `git status` 确认工作区恢复干净
