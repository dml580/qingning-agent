# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## 浏览器回归

在 `web` 目录运行：

```bash
python3 -m pip install -r ../server/requirements.txt
npm ci
npx playwright install chromium
npm run test:e2e
```

Playwright 自动启动隔离后端（18000）和前端（4174），需保持这两个端口空闲。
`tests/chat-reminder.spec.ts` 使用真实 API、SSE、提醒工具与临时 SQLite：从工作台发送提醒，校验提醒页的标题、日期时间，再切换页面并刷新确认持久化。外部模型使用演示模式，日历同步关闭，不读取已有数据库或模型运行时配置；临时数据库在服务退出时清理。
