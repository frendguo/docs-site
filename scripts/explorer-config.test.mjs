// quartz.config.yaml 里 explorer 插件 mapFn/sortFn 函数字符串的防回归测试。
// 这两个函数以字符串写在 yaml 里,由 explorer 插件客户端脚本用 new Function 重建执行
// (见 .quartz/plugins/explorer explorer.inline.ts),改坏了只会在浏览器里静默失效,
// 故在此按同样方式重建并验证行为。
// 运行: npm test (tsx --test 自动发现)
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const cfg = parse(readFileSync(new URL("../quartz.config.yaml", import.meta.url), "utf8"))
const explorer = cfg.plugins.find(
  (p) => typeof p.source === "string" && p.source.endsWith("/explorer"),
)

describe("explorer 配置函数字符串", () => {
  it("explorer 插件存在且带 mapFn/sortFn 字符串", () => {
    assert.ok(explorer, "未找到 explorer 插件配置")
    assert.equal(typeof explorer.options?.mapFn, "string")
    assert.equal(typeof explorer.options?.sortFn, "string")
  })

  it("mapFn:去「NN - 」前缀,无前缀/无 displayName 不受影响", () => {
    // 与 explorer.inline.ts 的重建方式一致
    const mapFn = new Function("node", "(" + explorer.options.mapFn + ")(node)")
    const cases = [
      { in: "00 - Agent", out: "Agent" },
      { in: "1 - AI", out: "AI" },
      { in: "01 - AI 工具集", out: "AI 工具集" },
      { in: "一文玩转 Claude Code", out: "一文玩转 Claude Code" },
    ]
    for (const c of cases) {
      const node = { displayName: c.in }
      mapFn(node)
      assert.equal(node.displayName, c.out)
    }
    const bare = {}
    mapFn(bare) // displayName 缺失不抛错
    assert.equal(bare.displayName, undefined)
  })

  it("sortFn:文件夹在前按专题序,文件按原 title 数字序(英文 slug + 隐藏 NN - 前缀下顺序不变)", () => {
    const sortFn = new Function("a", "b", "return (" + explorer.options.sortFn + ")(a, b)")
    const nodes = [
      {
        isFolder: false,
        slugSegment: "cli-tools",
        displayName: "CLI 工具",
        data: { title: "05 - CLI 工具" },
      },
      {
        isFolder: true,
        slugSegment: "originals",
        displayName: "原文存档",
        data: { title: "原文存档" },
      },
      {
        isFolder: false,
        slugSegment: "ai-tools",
        displayName: "AI 工具集",
        data: { title: "01 - AI 工具集" },
      },
      {
        isFolder: true,
        slugSegment: "claude-code",
        displayName: "ClaudeCode 实践",
        data: { title: "ClaudeCode 实践" },
      },
      {
        isFolder: true,
        slugSegment: "agent",
        displayName: "Agent",
        data: { title: "Agent" },
      },
      {
        isFolder: false,
        slugSegment: "master-claude-code",
        displayName: "一文玩转 Claude Code",
        data: { title: "03 - 一文玩转 Claude Code" },
      },
    ]
    const sorted = [...nodes].sort(sortFn)
    assert.deepEqual(
      sorted.map((n) => n.slugSegment),
      ["agent", "claude-code", "originals", "ai-tools", "master-claude-code", "cli-tools"],
    )
  })
})
