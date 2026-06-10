// ESLint v9 flat config(本 fork 自加,上游无此文件;与上游同步时整文件保留即可)
import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    // 构建产物、转译缓存、CI 拉取的内容、上游打包产物不 lint
    ignores: [
      "node_modules/**",
      "public/**",
      ".quartz/**",
      "**/.quartz-cache/**",
      "content/**",
      "docs/**",
      "prof/**",
      "quartz/cli/tui/dist/**",
      "quartz/static/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // 下划线开头 = 刻意未用(上游与本仓库的共同惯例)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { varsIgnorePattern: "^_", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 上游源码(quartz/ 与根目录 *.d.ts):关闭其现存命中的风格/惯用法规则,
    // 只留真 bug 类规则(no-dupe-keys、no-unreachable 等仍生效)。
    // 上游不跑 ESLint,这些命中不在本仓库修,避免制造与上游同步的冲突。
    // scripts/ 与 .claude/ 等自有代码不在此列,维持全量严格。
    files: ["quartz/**/*.{ts,tsx,js,mjs}", "*.d.ts"],
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-case-declarations": "off",
      "no-empty": "off",
      "no-extra-boolean-cast": "off",
      "no-useless-assignment": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
      "preserve-caught-error": "off",
    },
  },
)
