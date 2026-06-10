// PostToolUse(Write|Edit) 钩子:对刚编辑的文件跑 Prettier
// 用 node 直调 prettier.cjs 而非 npx/shell,避免 Windows cmd 对含空格路径的拆分
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

let raw = ""
process.stdin.on("data", (c) => (raw += c))
process.stdin.on("end", () => {
  let file
  try {
    const payload = JSON.parse(raw)
    file = payload.tool_response?.filePath ?? payload.tool_input?.file_path
  } catch {
    // stdin 不是合法 JSON 时静默放行
  }
  if (!file || !existsSync(file)) process.exit(0)
  const bin = "node_modules/prettier/bin/prettier.cjs"
  if (!existsSync(bin)) process.exit(0)
  // 静默执行;格式化失败(如语法错误的中间态文件)不阻塞 Claude,交给 npm run check 兜底
  spawnSync(process.execPath, [bin, "--write", "--ignore-unknown", file], {
    stdio: "ignore",
  })
  process.exit(0)
})
