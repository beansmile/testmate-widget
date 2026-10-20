# TestMate Widget

TestMate 反馈小组件：在任意网站里嵌入一个反馈入口，让用户圈选页面元素、画标注、录屏，并把问题连同上下文（截图、控制台错误、浏览器信息、操作轨迹）提交到 [TestMate](https://testmate.beansmile.ai)。

> Forked from [makethisbetter/makethisbetter-js](https://github.com/makethisbetter/makethisbetter-js), MIT。基于上游 **v1.30.1**（commit `807ead5`）。上游原始 README 保留在 [UPSTREAM_README.md](./UPSTREAM_README.md)，API 协议见 [SELF_HOSTING.md](./SELF_HOSTING.md)。

[English](#english) · 中文

## 快速开始

### Script 标签（推荐）

```html
<script src="https://testmate.beansmile.ai/widget/testmate.js"></script>
<script>TestMate.init({ projectKey: 'mtb_proj_…' })</script>
```

`projectKey` 在 TestMate 后台「项目设置 → 小组件」里复制。`window.MakeThisBetter` 作为兼容别名仍然可用，按上游文档写的代码无需修改。

### npm / git 安装

本包没有发布到 npm registry，直接从 GitHub 安装（安装时 `prepare` 会自动构建 `dist/`）：

```bash
npm i github:beansmile/testmate-widget
```

```ts
import { TestMate } from '@beansmile/testmate-widget'

TestMate.init({ projectKey: 'mtb_proj_…' })
```

也可以直接使用构建产物（`npm run build` 后位于 `dist/`）：

| 文件 | 用途 |
| --- | --- |
| `dist/testmate.iife.js` | 经典 `<script>`，暴露 `window.TestMate`（线上即 `/widget/testmate.js`） |
| `dist/testmate.esm.js` + `dist/html-to-image.js` | ES module（截图库按需加载的 chunk 需放在同目录） |
| `dist/testmate.standalone.js` | 单文件 ES module（无额外 chunk，适合直接拷贝进项目） |
| `dist/testmate.cjs` | CommonJS |
| `dist/testmate.d.ts` | 单文件类型声明（含 `window.TestMate`） |
| `dist/rrweb-record.js` | 录屏用的 `@rrweb/record@2.1.0` UMD（与 jsDelivr 上的文件逐字节一致） |

## 配置项

```js
TestMate.init({
  projectKey: 'mtb_proj_…',   // 必填
  locale: 'zh-CN',
  apiUrl: 'https://testmate.beansmile.ai/api/v1',
})
```

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `projectKey` | `string` | — | 必填，项目密钥（`mtb_proj_…`） |
| `apiUrl` | `string` | `https://testmate.beansmile.ai/api/v1` | API 地址，自建或本地联调时覆盖 |
| `recorderUrl` | `string` | `https://testmate.beansmile.ai/widget/rrweb-record.js` | 录屏脚本地址（首次录屏时才加载） |
| `locale` | `string` | `<html lang>`，再回退到 `en` | `zh-CN` / `en` / `ja` / `ko` / `de` / `fr` / `es`；`fr-CA` 这类会退回 `fr` |
| `position` | `'left' \| 'right'` | `'right'` | 侧边标签位置；手机上则是悬浮按钮所在的角 |
| `tabText` | `string` | 当前语言的「反馈」 | 侧边标签文字（手机按钮只显示图标，文字作为无障碍名称） |
| `entryMode` | `'button' \| 'api'` | `'button'` | `api` 时任何设备都不渲染入口按钮，由你调用 `TestMate.open()` |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | 主题 |
| `brandColors` | `{ primary, hover, active, onPrimary }` | 默认绿色 | 四个值都必须是 `#RRGGBB`，否则整组忽略 |
| `frustrationDetection` | `boolean` | `true` | 检测用户受挫（连点、报错等）时主动提示 |
| `uploads` | `boolean` | `true` | 在反馈输入框显示回形针，反馈者可附上最多 5 张自己的图片（PNG / JPEG / WebP / GIF，单张压缩后不超过 10 MB）；`false` 隐藏 |
| `user` | `{ id?, email?, name? }` | — | 匿名模式下的反馈者信息；有有效 JWT 时被忽略 |
| `userToken` | `string` | — | 身份 JWT（见下文） |
| `userTokenFn` | `() => Promise<string>` | — | 每次请求前获取新 JWT（推荐） |

API：`TestMate.init(config)`、`destroy()`、`open()`、`close()`、`showLauncher()`、`hideLauncher()`、`setLocale(locale)`。

**入口按钮。** 桌面端是贴在页面侧边的标签；宽度不超过 480px 的屏幕（手机）改为右下角（或左下角）的圆形悬浮按钮，52px、避开安全区，并在反馈卡片、回执或受挫提示打开时自动让位。更宽的触屏设备（平板、横屏手机）仍用侧边标签，宽度放大到 44px 便于点按。`hideLauncher()` / `showLauncher()` 在所有设备上行为一致；`entryMode: 'api'` 则在任何设备上都不渲染内置入口。

## 身份验证（JWT）

默认匿名提交。若希望反馈与登录用户绑定（后台显示已验证徽章、用户可查看自己的反馈），在**你的服务器上**用项目的「签名密钥」（项目设置 → 身份验证）签发 HS256 JWT：

- 声明：`sub`（用户 id，必填）、`email`、`name`、`exp`（建议短期有效）
- 小组件把它放在 `X-User-Token` 请求头里发送
- 有有效 JWT 时，反馈者信息**只**取自 token，`user` 字段被忽略
- 永远不要把签名密钥暴露给浏览器；项目可开启「要求有效的用户令牌」拒绝匿名提交

```js
TestMate.init({
  projectKey: 'mtb_proj_…',
  userTokenFn: async () => (await (await fetch('/api/testmate-token')).json()).token,
})
```

```js
// Node 示例（jose）
import { SignJWT } from 'jose'
const token = await new SignJWT({ email: user.email, name: user.name })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(String(user.id))
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.MTB_SIGNING_SECRET))
```

## CSP（内容安全策略）

小组件脚本、录屏脚本和 API 都在 TestMate 自己的域名下，**不需要 unpkg 或 jsDelivr**：

```
script-src  https://testmate.beansmile.ai;
connect-src https://testmate.beansmile.ai;
```

- 录屏（`@rrweb/record@2.1.0`）在用户第一次点「录屏」时才从 `recorderUrl` 动态加载。默认地址与小组件同源，因此不带 SRI/`crossorigin`。如果你把 `recorderUrl` 设回 jsDelivr 的固定版本（`https://cdn.jsdelivr.net/npm/@rrweb/record@2.1.0/umd/record.min.js`），会自动带上 sha384 SRI，此时需要放行 `https://cdn.jsdelivr.net`。
- 页面上若已存在 `window.rrwebRecord`，小组件会直接使用而不再加载。
- 录屏脚本被 CSP 拦截时页面不受影响，小组件会回退到标注模式。
- 样式注入在 shadow root 内的 `<style>` 中；严格的 `style-src`（禁止 `'unsafe-inline'`）可能导致小组件无样式，请自行验证。
- 自建或本地环境：把上面的域名换成你的 `apiUrl` / 脚本所在域名。

## 开发

```bash
npm ci
npm test          # vitest
npm run build     # dist/testmate.*
npm run dev       # vite，打开 /index.html（mock API）或 /local.html（真实服务器）
```

`demo/local.html` 连接本地 TestMate 服务器：`http://localhost:5173/local.html?key=mtb_proj_…&api=http://localhost:3000/api/v1`。

发布到 TestMate：把 `dist/testmate.iife.js` 拷贝为 TestMate 应用的 `public/widget/testmate.js`，同时拷贝 `testmate.esm.js`、`html-to-image.js`、`testmate.d.ts`、`rrweb-record.js`。

## 与上游的差异

- 产品名改为 TestMate（弹窗标题、7 种语言文案、控制台前缀），移除指向 makethisbetter.dev 的链接
- 全局变量 `window.TestMate`（保留 `window.MakeThisBetter` 别名），ESM 导出 `TestMate`（保留 `MakeThisBetter`、`MakeThisBetterConfig` 别名）
- 默认 `apiUrl` 为 `https://testmate.beansmile.ai/api/v1`；新增 `recorderUrl`，默认从 TestMate 域名加载录屏脚本
- 包名 `@beansmile/testmate-widget`，构建产物 `dist/testmate.*`
- API 路由、请求头（`X-Project-Key`、`X-User-Token`、`X-Submission-Token`）、multipart 字段、DOM id/class（`mtb-widget-host`、`mtb-*`）、localStorage 键均与上游一致

---

<a id="english"></a>

## English

TestMate feedback widget: drop a feedback entry point into any website so users can pin elements, draw annotations, record their screen and send the report — with screenshot, console errors, browser info and breadcrumbs — to [TestMate](https://testmate.beansmile.ai).

> Forked from [makethisbetter/makethisbetter-js](https://github.com/makethisbetter/makethisbetter-js), MIT. Based on upstream **v1.30.1** (commit `807ead5`). The upstream README lives on in [UPSTREAM_README.md](./UPSTREAM_README.md); the API contract is in [SELF_HOSTING.md](./SELF_HOSTING.md).

### Quick start

```html
<script src="https://testmate.beansmile.ai/widget/testmate.js"></script>
<script>TestMate.init({ projectKey: 'mtb_proj_…' })</script>
```

Copy `projectKey` from Project settings → Widget in TestMate. `window.MakeThisBetter` stays defined as an alias, so code written against the upstream docs keeps working.

### npm / git install

Not published to the npm registry — install from GitHub (`prepare` builds `dist/` during install):

```bash
npm i github:beansmile/testmate-widget
```

```ts
import { TestMate } from '@beansmile/testmate-widget'
TestMate.init({ projectKey: 'mtb_proj_…' })
```

Build outputs: `dist/testmate.iife.js` (classic script, `window.TestMate`), `dist/testmate.esm.js` (+ sibling `html-to-image.js` chunk), `dist/testmate.standalone.js` (single-file ESM), `dist/testmate.cjs`, `dist/testmate.d.ts` (single-file types incl. `window.TestMate`), `dist/rrweb-record.js` (`@rrweb/record@2.1.0` UMD, byte-identical to jsDelivr's).

### Configuration

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `projectKey` | `string` | — | Required (`mtb_proj_…`) |
| `apiUrl` | `string` | `https://testmate.beansmile.ai/api/v1` | Override for self-hosted / local servers |
| `recorderUrl` | `string` | `https://testmate.beansmile.ai/widget/rrweb-record.js` | rrweb recorder, loaded on first recording |
| `locale` | `string` | `<html lang>`, then `en` | `zh-CN`, `en`, `ja`, `ko`, `de`, `fr`, `es`; region tags fall back (`fr-CA` → `fr`) |
| `position` | `'left' \| 'right'` | `'right'` | Side of the docked tab; on phones, the corner of the floating button |
| `tabText` | `string` | locale's "Feedback" | Tab label (the phone button shows an icon and uses it as its accessible name) |
| `entryMode` | `'button' \| 'api'` | `'button'` | `api` renders no launcher on any device; call `TestMate.open()` from your own UI |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | |
| `brandColors` | `{ primary, hover, active, onPrimary }` | green | All four as `#RRGGBB` or the group is ignored |
| `frustrationDetection` | `boolean` | `true` | Proactive prompt on rage clicks / errors |
| `uploads` | `boolean` | `true` | Paperclip in the note composer: reporters attach up to 5 images of their own (PNG / JPEG / WebP / GIF, each downscaled to ≤ 2560 px and ≤ 10 MB); `false` hides it |
| `user` | `{ id?, email?, name? }` | — | Anonymous reporter info; ignored when a valid JWT is present |
| `userToken` | `string` | — | Identity JWT |
| `userTokenFn` | `() => Promise<string>` | — | Fresh JWT before each request (recommended) |

Methods: `init`, `destroy`, `open`, `close`, `showLauncher`, `hideLauncher`, `setLocale`.

**Launcher.** Desktop gets a tab docked to the side of the page. Screens up to 480px wide (phones) get the same button as a round floating control in the bottom corner instead, 52px with safe-area insets, and it hides itself while the feedback sheet, the receipt or the frustration prompt is open. Touch devices wider than that (tablets, phones in landscape) keep the docked tab at a 44px tap width. `hideLauncher()` / `showLauncher()` work the same everywhere; `entryMode: 'api'` turns the built-in launcher off on every device.

### Identity (JWT)

Sign an HS256 JWT **on your server** with the project's Signing secret (Project settings → Identity). Claims: `sub` (required), `email`, `name`, `exp` (keep it short-lived). The widget sends it as `X-User-Token`; when it verifies, reporter id/email/name come only from the token and `user` is ignored. Never expose the secret to the browser. Projects can require a valid token and reject anonymous submissions.

```js
TestMate.init({
  projectKey: 'mtb_proj_…',
  userTokenFn: async () => (await (await fetch('/api/testmate-token')).json()).token,
})
```

### Content Security Policy

The widget, the recorder and the API are all served from TestMate's own origin — no unpkg or jsDelivr needed:

```
script-src  https://testmate.beansmile.ai;
connect-src https://testmate.beansmile.ai;
```

The rrweb recorder is lazy-loaded from `recorderUrl` the first time someone records. The default URL is same-origin with the widget, so it is loaded without SRI/`crossorigin`; pointing `recorderUrl` at the pinned jsDelivr file re-enables the sha384 SRI check (then allow `https://cdn.jsdelivr.net`). A pre-existing `window.rrwebRecord` global is used as-is. If CSP blocks the recorder, the widget falls back to markup mode. Styles live in a `<style>` inside the widget's shadow root, so a strict `style-src` without `'unsafe-inline'` may leave it unstyled.

### Development

```bash
npm ci && npm test && npm run build
npm run dev   # demo/index.html (mock API) or demo/local.html?key=…&api=http://localhost:3000/api/v1
```

### License

MIT — see [LICENSE](./LICENSE). Original work © 2026 MakeThisBetter; TestMate modifications © 2026 Beansmile.
