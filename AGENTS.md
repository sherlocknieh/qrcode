# AGENTS.md

给 AI Agent 与协作者的项目认知。改代码前先读本文件；用户可见说明见 [README.md](./README.md)。

## 概述

**WXT + Vue 3 + TypeScript** 跨浏览器（Chrome / Edge / Firefox）二维码扩展：生成二维码（当前页 / 选中文本），扫描二维码与一维条形码（网页图片 / 截图 / 本地图片 / 剪贴板），附带简易截图工具。

- 版本号在 [package.json](./package.json)，发布时同步 `version`。
- 无自动化测试，唯一静态校验是 `pnpm compile`（`vue-tsc --noEmit`）。

## 常用命令

```bash
pnpm install       # postinstall 会执行 wxt prepare
pnpm dev           # 并行调试 Chrome/Edge/Firefox，缺的浏览器静默跳过
pnpm dev:chrome    # 只调试 Chrome，缺浏览器则报错退出（edge / firefox 同理）
pnpm compile       # 类型检查，提交前必须通过
pnpm build         # 打包 Chrome/Edge zip
pnpm build:firefox # 打包 Firefox zip（含 sources）
pnpm submit:chrome|edge|firefox|all  # 构建并提交商店；wxt 自读 .env.submit（不要先 source：PEM 私钥是单行 \n）
```

- profile 按浏览器隔离于 `.wxt/dev-profile/<browser>`；测试页与端口配置在 [wxt.config.ts](./wxt.config.ts) 和 [.dev/dev.mjs](./.dev/dev.mjs)（后者注入 `WXT_DEV_BROWSER` / `WXT_DEV_CDP_PORT`）。
- 端口固定（Chrome 3000 / Edge 3001 / Firefox 3002，日志带 `[chrome]` 前缀，`pnpm dev:<browser>` 严格模式端口一致），可执行文件用 `CHROME_BINARY` / `EDGE_BINARY` / `FIREFOX_BINARY` 覆盖；`dev.server.strictPort` 开启，被占即报错（换端口会断热更新，两个实例还会争写 `.output`）。先结束旧进程或 `pnpm dev:chrome -- -p 3010`。
- 子进程没有 TTY，wxt 的 `o + enter` 失效，改由 [.dev/dev.mjs](./.dev/dev.mjs) 监听并重启全部浏览器。
- Chromium 启动后 [.dev/pin-dev-extension.mjs](./.dev/pin-dev-extension.mjs) 连调试端口（Chrome 9222 / Edge 9223），在 `chrome://extensions` 上下文调 `chrome.developerPrivate` 固定 dev 图标；Firefox 无此能力。

## 目录导航

| 路径 | 职责 |
| --- | --- |
| [src/entrypoints/background.ts](./src/entrypoints/background.ts) | 后台：右键菜单、打开 popup、通知中转、跨域取图、截图、关标签页、图标开关 |
| [src/entrypoints/content/](./src/entrypoints/content/) | 全站注入 UI；消息 `decodeQR` / `screenshotQR` / `scanFullScreen` / `scanImageInline`；页面内通知兜底 |
| [src/entrypoints/popup/](./src/entrypoints/popup/) | 工具栏弹窗：生成二维码、展示通知、扫描图片 |
| [src/entrypoints/upload/](./src/entrypoints/upload/) | `upload.html`：`?camera=1` 以摄像头模式开 `ScanPanel`；内容脚本注入不了时的兜底页 |
| [src/entrypoints/capture/](./src/entrypoints/capture/) | `capture.html`：视口图框选 / 直出扫描（PDF、SVG 兜底） |
| [src/components/ScreenshotOverlay.vue](./src/components/ScreenshotOverlay.vue) | 自研框选截图（拖拽、复制、保存）；确认后冻结为结果底图，蓝框直接标在截图上 |
| [src/components/ScanOverlay.vue](./src/components/ScanOverlay.vue) | 扫描动画（整屏 / 图片区域，不拦截交互） |
| [src/components/ScanMarks.vue](./src/components/ScanMarks.vue) | 全屏扫描命中后标出码的位置（方框，纯展示） |
| [src/components/QrCodePanel.vue](./src/components/QrCodePanel.vue) | 二维码生成面板（预览 + 单输入框） |
| [src/components/ScanPanel.vue](./src/components/ScanPanel.vue) | 唯一扫描面板：图片 / 摄像头两种 `mode` |
| [src/components/ImagePicker.vue](./src/components/ImagePicker.vue) | 取图区（粘贴 / 拖放 / 选文件） |
| [src/composables/useImagePasteOverlay.ts](./src/composables/useImagePasteOverlay.ts) | 浮层宿主：`createApp(ScanPanel, { variant: 'overlay', mode: 'image' })` |
| [src/composables/useScanAnimation.ts](./src/composables/useScanAnimation.ts) | 扫描动画挂载与淡出：`play()` 只等首帧，`stop()` 淡出后 resolve（用于延后弹窗） |
| [src/composables/useCodePicker.ts](./src/composables/useCodePicker.ts) | **各入口共用的多码点选**：`show(results, anchor)` 叠蓝点、`pick` 切结果、空白点击/宽度变化收起 |
| [src/services/imageRect.ts](./src/services/imageRect.ts) | `measureImageRect(img)`：按 `object-fit` 算图片实际绘制区域，点选锚点与扫描动画都靠它 |
| [src/services/decodeResultNotice.ts](./src/services/decodeResultNotice.ts) | 扫描提示与结果通知 |
| [src/composables/useNoticeFallback.ts](./src/composables/useNoticeFallback.ts) | 通知策略：popup 优先、页面内兜底 |
| [src/services/recognize.ts](./src/services/recognize.ts) | **唯一扫描入口** `recognizeImage(loader, options)`，`afterDecode` 会 await 等动画淡出 |
| [src/composables/useQrCode.ts](./src/composables/useQrCode.ts) | 防抖生成二维码，返回 `dataUrl` / 错误文案 |
| [src/composables/useImageSource.ts](./src/composables/useImageSource.ts) | 图片取图源 |
| [src/composables/useCameraScan.ts](./src/composables/useCameraScan.ts) | 摄像头取图源（逐帧轻量解码） |
| [src/services/messaging.ts](./src/services/messaging.ts) | 消息发送封装（lastError / success） |
| [src/services/i18n.ts](./src/services/i18n.ts) | `t()` 读文案 |
| [src/services/storage.ts](./src/services/storage.ts) | 存储区选择、`takeStoredValue/String` 读后即清 |
| [src/services/screenshotSettings.ts](./src/services/screenshotSettings.ts) | 框选入场动画开关（`storage.local`，默认开） |
| [src/components/NotifyHost.vue](./src/components/NotifyHost.vue) | 通知 UI（替代 SweetAlert2），只消费 `useNotify` |
| [src/composables/useNotify.ts](./src/composables/useNotify.ts) | 全局单例通知状态与 `fire/close/showLoading` |
| [src/composables/usePopupNoticeHost.ts](./src/composables/usePopupNoticeHost.ts) | popup 侧执行打开、复制、截图 |
| [src/composables/useScreenshot.ts](./src/composables/useScreenshot.ts) | 内容脚本侧截图流程 |
| [src/services/qrCode.ts](./src/services/qrCode.ts) | 编码与 PNG 生成 |
| [src/services/qrScanner.ts](./src/services/qrScanner.ts) | 扫描核心（ZXing） |
| [src/services/popupNotice.ts](./src/services/popupNotice.ts) | 跨进程通知协议 |
| [src/services/clipboard.ts](./src/services/clipboard.ts) | 复制文本 |
| [src/services/clipboardImage.ts](./src/services/clipboardImage.ts) | 从 DataTransfer 取图 |
| [src/services/linkText.ts](./src/services/linkText.ts) | 链接判断与补协议 |
| [src/services/menuIcons.ts](./src/services/menuIcons.ts) | Firefox 菜单内联图标 |
| [public/_locales/](./public/_locales/) | `en` / `zh_CN` 文案，key 成对维护 |
| [.dev/submit.mjs](./.dev/submit.mjs) | 清旧包 → 构建 → `wxt submit` |
| [.dev/dev.mjs](./.dev/dev.mjs) | `pnpm dev` 入口：多浏览器并行 |
| [.dev/pin-dev-extension.mjs](./.dev/pin-dev-extension.mjs) | 经调试端口固定 dev 图标 |

`@/` 指向 `src/`（WXT 自动生成，见 `.wxt/tsconfig.json`）。`.wxt/`、`.output/`、`node_modules/` 是产物目录，不要手改。

面板交互约束（别丢）：`QrCodePanel` 在 popup 里 `collapsible` 默认收起，入口是整块二维码热区（点击切换、键盘聚焦可切换且带描边，不再有箭头图标），两态尺寸与留白一致，聚焦即全选（复制走键盘，不再内嵌复制按钮）；`ScanPanel` 两源共用固定深色 4:3 取景框 + 一行提示 + 一行按钮（换源尺寸不变），标题右侧切源，`variant` 决定自带遮罩（浮层）或原地渲染（独立页）。

## 运行时架构

```mermaid
flowchart LR
  Menu[右键菜单/工具栏] --> BG[background.ts]
  BG -->|qrCodeText / qrImageUrl| Popup[popup]
  BG -->|qrCaptureImage| Capture[capture.html]
  Content[content script] -->|showNotification| BG
  BG -->|storage + Port| Popup
  Popup -->|NotifyHost 展示| User[用户]
  Content -->|popup 不可用时| NotifyHost[页面内 NotifyHost]
  BG -->|fetchImage 代理| Content
  Content -->|captureVisibleTab| BG
```

1. **特殊页面就地处理**：网页 / 本地 / 剪贴板图片走 `decodeQR`、`scanImageInline`；直接打开的 SVG 注入不了内容脚本，图片交 popup；截图与一键截屏截视口后开 `capture.html`（`?direct=1` 直识整图），Firefox 内置 PDF 阅读器同此。扫描要在需要 DOM 的地方完成，降级分发统一走 `tryContentAction` / `resolveActiveTabId` / `sendImageToPopup` / `openExtensionPage`。
2. **通知统一走 popup**：`showPopupNotice()` → 后台写 `qrNotification` 经 `popup` 长连接推送；popup 未开则优先 `pageAction.openPopup()`，不可用或被拒绝时回退 `action.openPopup()`，失败返回 `false` 时调用方回退页面内 `NotifyHost`。`capture.html` 的 payload 带 `closeOriginTab`，通知结束（`notificationResolved` 或 popup 关闭）时后台按 `originTabId` 关掉来源页。
3. **通知参数必须可序列化**：`PopupNoticeOptions` 只有 `loading`，动作由 `PopupNoticeAction`（`open` / `copy` / `screenshot`）描述。不要为“收起通知”加消息：通知已结束而 popup 被保留会留空白窗口，用下一条通知（如 `decodingQR`）替换；`notifyState.open` 转 false 且无内容时 popup 自行关闭。
4. **popup 易失焦**：选本地文件会关 popup，故 `upload.html` 与 `capture.html` 各自取图，结果走 `useNoticeFallback`；扫描结束**不自动关闭**（例外：popup 的“尝试截图扫描”要让出焦点）。`capture.html` 通知结束即关自身：popup 里由后台按 `closeTabId` 关，页面内由 `onLocalNoticeDone` 关（被替换不算结束）。临时页由 `openExtensionPage` 打开（`tabs.create` 带来源页 `windowId` 与 `index + 1` 紧邻原页，并在 `qrExtensionOriginTabs` 登记）：关闭走 `closeTabAndReturn`（先 `tabs.update(来源页, { active: true })` 再 `tabs.remove`），用户点 X 由 `tabs.onRemoved` 同样切回。
5. **后台负责高权限操作**：`tabs.captureVisibleTab`、跨域 `fetch`（返回 DataURL）、`tabs.remove`。

## 存储键（改动时需全局搜索）

| 键 | 位置 | 说明 |
| --- | --- | --- |
| `qrCodeText` | session（回退 local） | 待生成二维码的文本 |
| `qrImageUrl` | session（回退 local） | 待扫描图片的 DataURL / 地址 |
| `qrNotification` | session（回退 local） | popup 待展示的最新通知（含自增 `id` 去重） |
| `qrCaptureImage` | session（回退 local） | 后台截取的视口图，读后即删 |
| `qrExtensionOriginTabs` | session（回退 local） | 临时扩展页 id → 来源标签页 id，关闭前切回、关闭后清除 |
| `pageActionVisible` | local | Firefox 地址栏图标开关，默认显示 |

统一写法：`const storageArea = () => browser.storage.session ?? browser.storage.local;`

## 修改指引

- **右键菜单**：改 `background.ts` 的 `addContextMenus` + 点击分支，文案加进两个 locale（Chrome 用 emoji 前缀，Firefox 用 `menuIcons`）。
- **二维码生成**：编码与 PNG 在 [qrCode.ts](./src/services/qrCode.ts)，输入/预览在 [QrCodePanel.vue](./src/components/QrCodePanel.vue)；条形码生成未接入。
- **码的位置标记**：`DecodeResult.bounds` 是码在解码所用图像中的像素包围盒：裁剪候选图靠 `Candidate.offsetX/Y` 平移回原图，缩放/旋转过的条形码候选图靠 `BoundsMapper` 换算，其余统一由 `toRect` 夹紧。调用方用 `DecodeOutcome.imageSize` 与目标矩形换算成 CSS 像素再画框，别在解码层输出页面坐标。命中码时先由 `toMarkRects(results, anchor)` 换算蓝框，`anchor` 只描述"图像画在视口哪块矩形上"（整屏=视口、框选=选区并带 `clip`、网页图片/面板预览=`measureImageRect(img)` 的实际绘制区域、摄像头预览加 `mirrorX`），`recognizeImage` 传 `deferResults` 暂缓结果通知，再由宿主 `notifyResults(results, { pickHint: 多码 })` 与蓝点同时给出。页面上的蓝点交 `useCodePicker.show(results, anchor)` 渲染；框选截图改用 `ScreenshotSession.showResults(marks)`，浮层确认时已冻结，只按截图时的视口尺寸缩放，不再随页面滚动。点哪个码就把通知切到哪个码，可连续挑选；空白点击由 composable 在 `document` 捕获阶段判断（不铺全屏透明层，面板按钮照常可用），通知窗口刚被这次点击关掉时保留蓝点，只有窗口**宽度**变化会让页面重排时才收起。
- **扫描效果**：只改 [qrScanner.ts](./src/services/qrScanner.ts)。ZXing 用深路径导入（`@zxing/library/esm/core/...`），别改成包根导入；摄像头逐帧只走 `decodeCameraFrame`，换 `decodeAllFromImageData` 会卡预览；一维码命中后必须过 `isOneDResultConfirmed` 核对相邻行（文字行也能凑出校验位合法的条码，少了这层会把正文认成条形码），批量扫描里未通过的结果只遮罩不中断，否则一处误判会挡住同图真正的条码。二维码整图/码面矩形都没扫出时会把整图缩到 `QR_DOWNSCALE_DIMENSION` 再扫一遍（模块过大时 ZXing 的定位点会漏检），命中坐标靠 `Candidate.scale` 换回原图，这层别删。
- **摄像头扫码**：右键菜单的“摄像头扫码”（`scanCamera`）直接开 `upload.html?camera=1`；面板本体仍只在 `ScanPanel.vue`，不要塞进 popup（失焦即关）。内容脚本也能 `getUserMedia`，但受页面安全上下文与 `Permissions-Policy` 约束、权限归页面源，故浮层失败时降级 `upload.html?camera=1`；媒体流与取帧在 `useCameraScan.ts`，命中即停，用户点“继续扫描”恢复。新增输入方式只实现一个“产出图像”的源，别拆第二套面板/扫描流程。
- **通知外观/交互**：`NotifyHost.vue` + `useNotify.ts`；跨进程字段同步改 `popupNotice.ts` 与 `usePopupNoticeHost.ts`。
- **新增 UI 文案**：`public/_locales/en/messages.json` 与 `zh_CN/messages.json` 同时添加，代码里统一 `browser.i18n.getMessage(key)`（各入口有本地 `t()` 包装）。
- **权限 / manifest / 图标**：只改 [wxt.config.ts](./wxt.config.ts)。不要声明 `clipboardRead` / `clipboardWrite`：图片只从 paste/拖放事件读，文本复制在点击手势里，失败用 `execCommand('copy')` 兜底。
- **截图**：视图层 `ScreenshotOverlay.vue`；普通页面由 `useScreenshot.ts` 就地挂载（确认后浮层冻结成结果底图，`showResults` 叠蓝框，`close` 收起），SVG / PDF 等页面由 [capture/App.vue](./src/entrypoints/capture/App.vue) 接管（后台截视口 → 存储 → 框选/直出）。

## 编码约定

- 注释、提交信息、面向用户的说明用**中文**，标识符用英文。
- 缩进 4 空格（Vue `<template>` 内同样）；引号与分号跟随所在文件，新文件统一单引号 + 分号。
- 优先复用现有 service / composable，不要为单个页面另写通知、复制、识图逻辑。
- 不引入新依赖；重量级库已有 `@zxing/library`、`qrcode-generator`、`vue`。
- Chrome / Edge / Firefox 行为保持一致，平台差异用 `import.meta.env.FIREFOX` 分支。
- 不提交 `.env.submit`（商店凭据），也不改 `.env` 里的本机路径。
- 仓库暂未提交 lockfile，不要顺手提交新生成的 `pnpm-lock.yaml`，除非用户明确要求。
- `pnpm-workspace.yaml` 用 `patchedDependencies` 给 `web-ext` 打补丁（`.dev/web-ext.patch` 去掉自动加的 `navigator.webdriver` 参数），升级后确认补丁仍能应用。

## 已知坑

- **大图扫描阻塞 UI**：先渲染 loading 通知，再 `await new Promise(r => setTimeout(r, 50))` 后解码。
- **提示分两段，动画在取图之后**：网络取图慢于 150ms 才提示“正在获取图片...”（`notifyFetching`），图就绪后才提示“正在扫描...”并播动画（`beforeNotice`）；本地图 / 截图不需要 `notifyFetching`。
- **跨域 / 防盗链图片**：直接 fetch 常失败，失败提示里保留“改用截图扫描”出口；不要再加“跨域可能稍慢”通知，与“正在获取图片...”重复。
- **同源重定向到 CDN**：如 GitHub 的 `/owner/repo/raw/...` 302 到 `raw.githubusercontent.com`，`isSameOrigin` 只看跳转前地址，Chrome 因此判 canvas 被污染。`loadImageDataFromUrl` 捕获污染错误后自动改走后台代理，这层兜底不能删；`fetchViaProxy` 也别改回只在跨域时传。
- **`file://` 页面**：Firefox 扩展页/后台无法 fetch，但内容脚本能读已渲染图片画到 canvas，失败再回退截取视口。
- **通知竞态与清理**：后台 `openPopup` 期间用 `popupOpening` / `POPUP_OPEN_GRACE` 防丢通知，靠自增 `id` 做 `clearNoticeIfCurrent`；popup 断开连接时后台删 `qrNotification`，避免下次重复弹出。都不要简化。
- **页面全局 CSS 会泄漏进注入 UI**：如 `example.com` 的 `svg { margin: -2.75em auto 0; opacity: .55 }` 会把图标顶到按钮外；新增图标时在 `.qr-shot` / `.qr-notify-root` / `.qr-picker-icon` 上声明完整 `margin` 与 `opacity`。
- **独立 SVG/XML 文档不要挂 integrated UI**：直接打开的 `.svg`（如 `https://app.trakt.tv/favicon.svg`）里 `document.createElement('div')` 没有 `.style`，`createIntegratedUi` 会在 `applyPosition` 设 `overflow` 时抛 `Cannot set properties of undefined`。`content/index.ts` 已在 `main()` 开头做能力检查跳过这类文档，扫描交 popup / `capture.html`，不要删。
- **开发时固定图标**：未打包扩展的 pin 只在内存里，写 `.wxt/dev-profile/.../Preferences` 的 `extensions.pinned_extensions` 无效；只能由 `.dev/pin-dev-extension.mjs` 运行时调 `chrome.developerPrivate.updateExtensionConfiguration`。改这段前先用 CDP 实测。

## 完成标准

1. `pnpm compile` 通过。
2. 新增文案在 `en` / `zh_CN` 两个 locale 中都存在。
3. 不夹带无关修改；提交信息简洁说明用户可见变化。

每次对话完成后提示用户是否提交更改，若用户确认则执行 `pnpm compile` 检查通过后提交。