---
name: ship
description: 攒批推送并部署到生产：汇总本地未推送的提交，跑 check/lint/test 三连验证，经用户确认后推送 v5 分支（即触发生产部署），用 gh CLI 按 commit SHA 盯准本次 GitHub Actions 运行直到部署完成，最后验证线上站点可访问。用户说「发布」「上线」「推送部署」「把攒的提交推了」或 /ship 时使用。
disable-model-invocation: true
---

把本地攒下的提交批量推送到 v5 并跟踪部署到完成。推送 v5 = 立即生产部署，所以推送前必须经用户明确确认。

## 步骤

1. **安全检查**（任一不满足就停下来报告）
   - 当前分支必须是 v5
   - 工作区必须干净（`git status --porcelain` 为空）；尤其确认 `.gitignore` 没有 /preview 留下的未还原改动
   - `git ls-files content/` 只应有 `content/.gitkeep` 和 `content/index.md`，多出任何文件说明预览内容被误暂存，必须先处理

2. **汇总待推送提交**：`git fetch origin` 后列出 `git log origin/v5..HEAD --oneline`；没有待推送提交则直接结束。把提交列表展示给用户

3. **推送前验证三连**（任一失败则停下修复，不推送）
   - `npm run check`（tsc + prettier）
   - `npm run lint`（ESLint）
   - `npm test`（脚本单测等）

4. **用户确认**：明确询问「确认推送这 N 个提交并触发生产部署吗？」，得到肯定答复才继续

5. **推送**：`git push origin v5`，记下 `git rev-parse HEAD` 的 SHA

6. **跟踪部署**（workflow 名为 Sync & Deploy，文件 deploy.yml）
   - push 后 run 的创建有几秒延迟：轮询 `gh run list --workflow=deploy.yml --limit 3 --json databaseId,headSha,status`，直到出现 headSha 等于刚推送 SHA 的 run（最多等约 30 秒），**用 SHA 匹配而不是直接取最新一条**，避免盯上定时触发的运行
   - `gh run watch <run-id> --exit-status` 等待完成（含 rclone 拉取和插件安装，约几分钟）
   - 失败则 `gh run view <run-id> --log-failed` 取失败日志并分析原因
   - 注：deploy.yml 的 concurrency 设了 cancel-in-progress，若有进行中的定时同步被本次推送取消属正常现象

7. **线上验证**：`Invoke-WebRequest https://ai-knowledge-base-15h.pages.dev -Method Head` 确认返回 200，向用户报告部署结果（附 run 链接和站点链接）
