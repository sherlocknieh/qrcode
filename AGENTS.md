# AGENTS.md

给 AI Agent 与协作者的项目认知。改代码前先读本文件；用户可见说明见 [README.md](./README.md)。

## 概述

**WXT + Vue 3 + TypeScript** 跨浏览器（Chrome / Edge / Firefox）二维码扩展：生成二维码（当前页 / 选中文本），扫描二维码与一维条形码（网页图片 / 截图 / 本地图片 / 剪贴板），附带截图扫描与框选重扫。

- 版本号在 [package.json](./package.json)，发布时同步 `version`。
- 无自动化测试，唯一静态校验是 `pnpm compile`（`vue-tsc --noEmit`）。

## 常用命令

```bash
pnpm install       # postinstall 会执行 wxt prepare
pnpm dev           # 只调试 Chrome：wxt -b chrome -p 3001，并自动固定 dev 图标
pnpm dev:firefox   # 只调试桌面 Firefox：wxt -b firefox --mv3（端口 3000）
pnpm dev:android   # Firefox for Android：wxt 只出 dev 版，web-ext 经 adb 装到手机，dev server 端口走 adb reverse 供热更新
pnpm wxt -b edge   # Edge 没有专用脚本，需要时手敲（端口由 wxt.config.ts 按浏览器给：Edge 3002）
pnpm compile       # 类型检查，提交前必须通过
pnpm build         # 打包 Chrome/Edge zip
pnpm build:firefox # 打包 Firefox zip（含 sources）
pnpm submit:chrome|edge|firefox|all  # 构建并提交商店；wxt 自读 .env.submit（不要先 source：PEM 私钥是单行 \n）
```

- profile 按浏览器隔离于 `.wxt/dev-profile/<browser>`；[wxt.config.ts](./wxt.config.ts) 从 `-b` 参数推导浏览器，据此选 profile 与调试端口，测试页也在那里配置。
- 端口按浏览器写死在 [wxt.config.ts](./wxt.config.ts) 的 `DEV_SERVER_PORTS`（Chrome 3001 / Firefox 3000 / Edge 3002），可执行文件用 `CHROME_BINARY` / `EDGE_BINARY` / `FIREFOX_BINARY` 覆盖（脚本不探测浏览器路径，缺浏览器由 wxt 报错）。同一个浏览器只能开一个 dev 实例：端口被占会直接 `ERROR Port 3000 is already in use` 退出（换端口会断热更新，两个实例还会争写 `.output`）。先结束旧进程再重启。
- `pnpm dev` 把 stdio 直接交给 wxt，wxt 自带的 `o` 键重启照常可用；`pnpm dev:android` 没有 TTY，日志按 `[wxt]` / `[android]` 前缀转发。
- `pnpm dev` 启动后 [.dev/pin-dev-extension.mjs](./.dev/pin-dev-extension.mjs) 连调试端口（Chrome 9222），在 `chrome://extensions` 上下文调 `chrome.developerPrivate` 固定 dev 图标；Firefox 无此能力。`pnpm dev:firefox` 与手敲的 Edge 不跑这层，需要时在 `chrome://extensions` 手动固定。
- 手机调试只支持 Firefox for Android（Chromium 系手机浏览器基本不支持扩展）：手机开 USB 调试并授权后跑 `pnpm dev:android`，脚本自动找 adb（`ADB_BIN` 可覆盖，默认按 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `~/Android/Sdk` 探测），`ANDROID_DEVICE` 指定多设备里的哪台，`FIREFOX_APK` 换 Nightly 等包名。桌面 Firefox 不会被拉起，装包与设备连接由 [.dev/android.mjs](./.dev/android.mjs) 负责（重装重跑命令，外壳脚本不再接管 `o` 键）；热更新复用 WXT dev server（端口 3000 经 `adb reverse` 打通），所以 web-ext 那边关了自带的 reload。
- 无线调试同一套流程：Android 11+ 在开发者选项里开「无线调试」→ `adb pair <ip>:<配对端口>` 输配对码 → `adb connect <ip>:<调试端口>`，`adb devices` 出现 `ip:port` 后脚本下一轮轮询就会自动安装（换设备时 `ANDROID_DEVICE=<ip>:port`）。`adb reverse` 走 adb 隧道，无线下热更新同样有效。

Agent 调试时用户大概率已经打开 pnpm dev ， Agent 直接复用该 dev server 在该浏览器上调试，无需自行打开 dev server。 有特殊的元素访问需求时可使用 vscode 内置浏览器调试。


## 目录导航

| 路径 | 职责 |
| --- | --- |
| [src/entrypoints/background.ts](./src/entrypoints/background.ts) | 后台入口：注册事件与右键菜单，其余行为都在 [src/services/background/](./src/services/background/) |
| [src/services/background/](./src/services/background/) | 后台能力按职责拆分，各模块直接导出函数、互相 import，不再注入回调：`pageAction`（Firefox 地址栏图标）、`extensionTabs`（临时扩展页开合、来源页回跳与扩展页端口）、`scanEntry`（内容脚本优先的扫描分发）、`screenScan`（截视口与 capture 页）、`messages`（运行时消息路由）；给内容脚本发消息与取活动标签页在 [messaging.ts](./src/services/messaging.ts) 的 `sendTabAction` / `resolveActiveTabId` |
| [src/entrypoints/content/](./src/entrypoints/content/) | 全站注入 UI；消息 `scanWebImage` / `scanScreen` / `scanLocalImage` / `frameScan`；页面内通知兜底 |
| [src/entrypoints/popup/](./src/entrypoints/popup/) | 工具栏弹窗：生成二维码、展示通知、扫描图片 |
| [src/entrypoints/upload/](./src/entrypoints/upload/) | `upload.html`：`?camera=1` 以摄像头模式开 `ScanPanel`；内容脚本注入不了时的兜底页 |
| [src/entrypoints/capture/](./src/entrypoints/capture/) | `capture.html`：截视口后直出扫描（PDF、SVG 等注入不了内容脚本的页面兜底）；`?frame=1` 由「框选扫描」打开，同一张视口图直接以可框选层呈现，不自动整屏扫 |
| [src/components/ScreenshotOverlay.vue](./src/components/ScreenshotOverlay.vue) | 截图容器：承载截图扫描的结果（冻结截图 + 绿框绿点），结果画面上仍可拖框另选一块重扫；拖框的选框与手柄用蓝色（`SELECTION_COLOR`，与结果绿框区分），只有拖框与确认按钮，点空白或 Esc 退出；浏览器窗口变化时整层自动收成居中大浮窗，尺寸/位置带 0.34s 过渡（`qr-shot--transitioning`，只在进入浮窗时短暂开启） |
| [src/components/ScanOverlay.vue](./src/components/ScanOverlay.vue) | 扫描动画（整屏 / 图片区域，不拦截交互）；图片区域按 [overlayHost.ts](./src/services/overlayHost.ts) 挂进图片所在容器并排在图片之后，只压住图片而不越过后加入的页面浮层 |
| [src/components/ScanMarks.vue](./src/components/ScanMarks.vue) | 命中后在码上标绿框，多码时才叠可点绿点（单码只留绿框、框内点击就地吞掉不做点选，结果通知已经展示过）；`picked` 记录点开过的码，这些只留绿框、摘掉圆点也不再点选，但框内照旧挡住点击，不让它穿到网页；网页图片传 `anchor` 跟随图片所在层（同 [overlayHost.ts](./src/services/overlayHost.ts)），截图容器里则铺在其结果层内 |
| [src/services/overlayHost.ts](./src/services/overlayHost.ts) | 扫码叠加层（扫描动画、命中绿框）的挂载策略：优先挂进图片容器只压住图片；祖先改掉 `fixed` 参照时退回 `body` 保持最高层 |
| [src/components/QrCodePanel.vue](./src/components/QrCodePanel.vue) | 二维码生成面板（预览 + 单输入框 + 展开后的复制/下载与扫码入口） |
| [src/components/ScanPanel.vue](./src/components/ScanPanel.vue) | 唯一扫描面板：图片 / 摄像头两种 `mode` |
| [src/components/ImagePicker.vue](./src/components/ImagePicker.vue) | 取图区（粘贴 / 拖放 / 选文件） |
| [src/composables/useImagePasteOverlay.ts](./src/composables/useImagePasteOverlay.ts) | 浮层宿主：`createApp(ScanPanel, { variant: 'overlay', mode: 'image' })` |
| [src/composables/useScanAnimation.ts](./src/composables/useScanAnimation.ts) | 扫描动画挂载与淡出：`play()` 只等首帧，`stop()` 淡出后 resolve（用于延后弹窗） |
| [src/composables/useCodePicker.ts](./src/composables/useCodePicker.ts) | **各入口共用的多码点选**：`show(results, anchor)` 叠绿框绿点（多条结果时弹一条“发现多个码”提示、列表默认收起，点“显示全部”才摊开，点某个码再逐条出结果通知；只有一条结果时只留绿框、不叠绿点，免得压在码中央挡内容，这块绿框只标位置、框内点击就地吞掉（不点选也不穿到网页）——结果通知已经展示过这个码，否则关掉通知还能反复点出同一条）、`pick` 切结果（只把该码记成 `picked`，绿框留着、圆点摘掉）、`remaining` 给出还没点开的码数供宿主收尾、空白点击/宽度变化收起 |
| [src/services/imageRect.ts](./src/services/imageRect.ts) | `measureImageRect(img)`：按 `object-fit` 算图片实际绘制区域，点选锚点与扫描动画都靠它 |
| [src/services/decodeResultNotice.ts](./src/services/decodeResultNotice.ts) | 结果与错误通知 |
| [src/composables/useNoticeFallback.ts](./src/composables/useNoticeFallback.ts) | 通知策略：popup 优先、页面内兜底 |
| [src/services/recognize.ts](./src/services/recognize.ts) | **唯一扫描入口** `recognizeImage(loader, options)`，`afterDecode` 会 await 等动画淡出 |
| [src/composables/useQrCode.ts](./src/composables/useQrCode.ts) | 防抖生成二维码，返回 `svg` / `dataUrl`(PNG 预览) / 错误文案 |
| [src/composables/useImageSource.ts](./src/composables/useImageSource.ts) | 图片取图源 |
| [src/composables/useCameraScan.ts](./src/composables/useCameraScan.ts) | 摄像头取图源（逐帧轻量解码） |
| [src/services/messaging.ts](./src/services/messaging.ts) | 消息发送封装（lastError / success） |
| [src/services/i18n.ts](./src/services/i18n.ts) | `t()` 读文案 |
| [src/services/storage.ts](./src/services/storage.ts) | 存储区选择、`takeStoredValue/String` 读后即清 |
| [src/services/screenshotSettings.ts](./src/services/screenshotSettings.ts) | 框选入场动画开关（`storage.local`，默认开） |
| [src/components/NotifyHost.vue](./src/components/NotifyHost.vue) | 通知 UI（替代 SweetAlert2），只消费 `useNotify` |
| [src/composables/useNotify.ts](./src/composables/useNotify.ts) | 全局单例通知状态与 `fire/close/showLoading` |
| [src/composables/usePopupNoticeHost.ts](./src/composables/usePopupNoticeHost.ts) | popup 侧执行打开、复制、截图 |
| [src/composables/useScreenshot.ts](./src/composables/useScreenshot.ts) | 截图容器的挂载与开合；`src` 复用已截好的图，`intro` 控制入场动画 |
| [src/composables/useScreenshotScan.ts](./src/composables/useScreenshotScan.ts) | **截图扫描的唯一流程**：一张截图 + 框选/整屏 → 解码 → 在冻结截图上标绿点、点选逐条出结果；全屏扫描就是“自动对整屏框选一次”，内容脚本与 [capture/App.vue](./src/entrypoints/capture/App.vue) 共用 |
| [src/services/qrCode.ts](./src/services/qrCode.ts) | 编码与 SVG 生成（预览 / 复制的 PNG 由同一份 SVG 光栅化） |
| [src/services/qrScanner.ts](./src/services/qrScanner.ts) | 扫描核心（ZXing） |
| [src/services/popupNotice.ts](./src/services/popupNotice.ts) | 跨进程通知协议 |
| [src/services/popupHost.ts](./src/services/popupHost.ts) | 后台侧 popup 宿主：通知落盘/推送、打开窗口、开合竞态兜底 |
| [src/services/clipboard.ts](./src/services/clipboard.ts) | 复制文本 |
| [src/services/clipboardImage.ts](./src/services/clipboardImage.ts) | 从 DataTransfer 取图 |
| [src/services/linkText.ts](./src/services/linkText.ts) | 链接判断与补协议 |
| [src/services/menuIcons.ts](./src/services/menuIcons.ts) | Firefox 菜单内联图标 |
| [public/_locales/](./public/_locales/) | `en` / `zh_CN` 文案，key 成对维护 |
| [.dev/submit.mjs](./.dev/submit.mjs) | 清旧包 → 构建 → `wxt submit` |
| [.dev/dev.mjs](./.dev/dev.mjs) | `pnpm dev` 入口：只调 Chrome，固定端口 + 自动固定 dev 图标 |
| [.dev/android.mjs](./.dev/android.mjs) | `pnpm dev:android` 入口：adb + web-ext 装到手机 |
| [.dev/pin-dev-extension.mjs](./.dev/pin-dev-extension.mjs) | 经调试端口固定 dev 图标 |

`@/` 指向 `src/`（WXT 自动生成，见 `.wxt/tsconfig.json`）。`.wxt/`、`.output/`、`node_modules/` 是产物目录，不要手改。

面板交互约束（别丢）：`QrCodePanel` 在 popup 里 `collapsible` 默认收起，入口是整块二维码热区（点击切换、键盘聚焦可切换且带描边，不再有箭头图标；鼠标点击由 `.qr-panel-preview` 容器处理，`.qr-panel-toggle` 只留给键盘、`pointer-events: none`，否则右键命中的是按钮而非 `<img>`，浏览器只按 `page` 上下文出菜单，`contexts: ['image']` 的「扫描图片」不会出现），两态尺寸与留白一致，抽屉内容与二维码同宽（它是纵向 flex 的子项，不写满宽度就会按输入框固有宽度收缩、两侧多出一圈空白），输入框未聚焦时只显示占位提示、聚焦才露出当前文字（值不随失焦清空，二维码照旧），手动改过之后失焦也保持显示（否则刚输入的文字像没生效），聚焦不做全选，占位提示用文本框（textarea）显示整句、不缩字号，文本框高度随内容行数长高（下限一行、超过 `25vh` 转框内滚动；空值时 `scrollHeight` 已含换行后的提示高度，别再加两行下限），编辑区用 `grid-template-rows: 0fr → 1fr` 撑高、内容留在顶部原地显形（别再让内容跟着外框平移或叠 `transform`：内容不动就不必逐帧重排重绘，火狐弹窗才不卡；也别写死高度、别改成绝对/固定定位——那样会撑出可滚动区域，弹窗窗口缩不回来），弹窗里禁掉 `html` 滚动条（动画期间文档比窗口高，不裁会闪滚动条），二维码始终带底部投影（展开时表示它压在抽屉上面；收起态不额外留白，弹窗窗口按内容尺寸成型会把它自然裁掉，只有用标签页打开 popup 页面时才靠这层投影把码块凸出来），展开态在输入框下方按 3 列排两行按钮，图标在上、文字在下（复制 / PNG / SVG 与相机 / 屏幕 / 图片；文字允许换行，按钮必须 `min-width: 0`，否则英文的 `Scan Camera` 会把三个格子撑出 220px 面板、整个抽屉连输入框一起溢出弹窗；完整说明留在悬停提示里，PNG 带白底、SVG 透明背景靠格式缩写区分），预览区用 `flashText` 叠临时文案（popup 的右键彩蛋走这里：半透明遮罩铺满整个码面、文案居中，绝对定位不占尺寸，抽屉展开时也不会跑到面板下沿）；`ScanPanel` 两源共用深色取景框 + 一行提示 + 一行按钮，摄像头模式的取景框按相机画面宽高比自适应（高度封顶 `56vh` 后再按同一比例收窄宽度，竖屏手机不留黑边；图片模式仍是 16:9），画面只在正对用户的摄像头上镜像（手机后置保持真实朝向，`mirrorX` 跟着镜像状态走），标题右侧切源，`variant` 决定自带遮罩（浮层）或原地渲染（独立页）。

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

1. **特殊页面就地处理**：网页 / 本地 / 剪贴板图片走 `scanWebImage`、`scanLocalImage`；直接打开的 SVG 注入不了内容脚本，图片交 popup；扫描屏幕在内容脚本不可用时由后台截视口后开 `capture.html` 直识整图（Firefox 内置 PDF 阅读器同此）。通知里的「框选扫描」（`requestFrameScan`）也是三级降级：内容脚本开浮层 → 扩展页（`capture.html`）经端口推回、在同一张截图上换成可框选层 → 两者都不在时截视口开 `capture.html?frame=1`。扫描要在需要 DOM 的地方完成，降级分发统一走 `tryContentAction` / `resolveActiveTabId` / `sendImageToPopup` / `openExtensionPage`。
2. **通知统一走 popup**：`showPopupNotice()` → 后台写 `qrNotification` 经 `popup` 长连接推送；popup 未开则优先 `pageAction.openPopup()`，不可用或被拒绝时回退 `action.openPopup()`，失败返回 `false` 时调用方回退页面内 `NotifyHost`。`capture.html` 的 payload 带 `closeOriginTab`，通知结束（`notificationResolved` 或 popup 关闭）时后台按 `originTabId` 关掉来源页；扫到多个码时只有点完最后一条绿点的通知才带这个标记，中间的关掉通知只回到截图上继续点。通知结束同样会通过记录里的 `sourceTabId` 向发起它的内容脚本转发 `notificationResolved`，用于清扫描标记并收起全屏扫描的截图浮层。
3. **通知参数必须可序列化**：`PopupNoticeOptions` 只有 `loading`，动作由 `PopupNoticeAction`（`open` / `copy` / `screenScan` / `frameScan`）描述。不要为“收起通知”加消息：通知已结束而 popup 被保留会留空白窗口，用下一条通知（结果 / 无结果）替换；`notifyState.open` 转 false 且无内容时 popup 自行关闭。
4. **popup 易失焦**：选本地文件会关 popup，故 `upload.html` 与 `capture.html` 各自取图，结果走 `useNoticeFallback`；扫描结束**不自动关闭**（例外：popup 的“改用扫描屏幕”要让出焦点）。`capture.html` 通知结束即关自身：popup 里由后台按 `closeTabId` 关，页面内由 `onLocalNoticeDone` 关（被替换不算结束）；多码点选时 `closeOriginTab` 传函数，只有最后一条绿点触发的通知会在收起后关页，前面几条留页继续点；点「框选扫描」时后台调 `popupHost.keepTab()` 摘掉记录里的 `closeTabId`，否则 popup 一关就会把正要框选的那一页一起关掉。临时页由 `openExtensionPage` 打开（`tabs.create` 带来源页 `windowId` 与 `index + 1` 紧邻原页，并在 `qrExtensionOriginTabs` 登记）：关闭走 `closeTabAndReturn`（先 `tabs.update(来源页, { active: true })` 再 `tabs.remove`），用户点 X 由 `tabs.onRemoved` 同样切回。
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

- **右键菜单**：改 [background.ts](./src/entrypoints/background.ts) 的 `addContextMenus` + `handleContextMenuClick` 分支，文案加进两个 locale（Chrome 用 emoji 前缀，Firefox 用 `menuIcons`）。popup 是扩展页面而不是标签页，在它自己的二维码上右键时没有可用的标签页：Chrome 给 `TAB_ID_NONE`（-1，直接 `tabs.sendMessage` 会抛错），Firefox 干脆不给 `tab`。因此 `scanWebImage` 分支的 `requestWebImageScan` 先判断“菜单位于 popup”（`info.pageUrl` 去掉查询串后等于 `runtime.getURL('/popup.html')`），是就直接发 `scanPopupQr` 弹随机彩蛋气泡（扫自己刚生成的二维码没有意义，别真去解码），不再走内容脚本与取图流程。这个判断依赖 `.qr-panel-toggle` 不接收指针，右键才会命中 `<img>`。这个彩蛋不能改用通知：通知尺寸（360 宽）和二维码面板（220×220）不同，popup 窗口会在两者之间重排，收起时白闪一下。
- **二维码生成**：以 [qrCode.ts](./src/services/qrCode.ts) 的 SVG 为唯一来源（只画深色模块、背景透明），预览、复制、PNG 下载都由它 `svgToPngDataUrl()` 光栅化成带白底的位图，SVG 下载直接给源文件，别再另写一套 canvas 绘制；输入/预览在 [QrCodePanel.vue](./src/components/QrCodePanel.vue)；条形码生成未接入。
- **码的位置标记**：`DecodeResult.bounds` 是码在解码所用图像中的像素包围盒：裁剪候选图靠 `Candidate.offsetX/Y` 平移回原图，缩放/旋转过的条形码候选图靠 `BoundsMapper` 换算，其余统一由 `toRect` 夹紧。**换算回原图之后的补高与夹紧一律按原图尺寸算，不能按候选图尺寸**（超过 `BARCODE_SCAN_DIMENSION` 的截图会先被缩小，按候选图高度夹会把原图的 y 压到候选图高度上，条形码标记就塌成一条线并跑到别处）。一维结果的定位点只到扫描行，条高方向就是包围盒的短边，由 `measureBarcodeBounds` 在原图上按条空剖面找连续带、再逐行解码确认，别再退回按宽度比例估算（UPC 条高约等于宽的一半，估算只补了宽度的 8%）。**条空排列方向上定位点在起始/终止图案的中心**（UPC/EAN 是 3 模块定界符中间的空隙、Code 128 是起始符中心），直接当边缘会把最外两根黑条切在框外，由 `measureBarEdges` 沿该方向走到静区取最外黑像素，别改回直接用定位点。调用方用 `DecodeOutcome.imageSize` 与目标矩形换算成 CSS 像素再画框，别在解码层输出页面坐标。命中码时先由 `toMarkRects(results, anchor)` 换算绿框，`anchor` 只描述"图像画在视口哪块矩形上"（在结果画面里另框一块=选区并带 `clip`、网页图片/面板预览=`measureImageRect(img)` 的实际绘制区域、摄像头预览加 `mirrorX`）；网页图片的锚点要带 `measureRect`，绿框每次重算都取图片实时位置——只按滚动差量平移的话，固定不随页面滚动的图片（图片查看器、`position: fixed` 浮层）上绿框会随滚动漂移，`recognizeImage` 传 `deferResults` 暂缓结果通知，再由宿主叠绿点并调用 `notifyPickedResults(results)`：多条结果弹一条“发现多个码”提示（`multiFoundNotice`，列表默认收起，点“显示全部”展开），用户点某个码再逐条出结果通知；只有量不到绿点位置时才用 `notifyResults(results)` 直接列出。**扫描屏幕与截图扫描共用 `useScreenshotScan`，但显示层分两种**：全屏扫描用 `open({ src, autoCapture })` 打开**只读结果层**（`selectable: false`），只展示静止截图与结果绿点，没有框选、工具栏和关闭按钮；没扫到时通知里给出「框选扫描」入口，点是切换到可框选的截图工具，直接关掉通知则收起（`closeShotOnNotice`）；通知已经关掉后点画面空白同样可以收起（先用 `isNoticeVisible` 确认通知窗口不在，避免把关通知的这一次点击也当成收起）；手动框选入口（`frameScan`）保留框选与重扫，界面上只有拖框和确认按钮（点空白或 Esc 退出），失败后保留截图与这次的挖空范围，用户能看清刚才扫的是哪一块接着拖下一块。两种都复用同一条 `scan` 流程：扫描动画播在选中的区域上（浮窗模式下先用 `ScreenshotSession.toViewportRect` 把选区换算到视口坐标），结果按解码图坐标换算后标在冻结截图上，遮罩在结果绿框内部挖空（`draw()` 里按 `sourceViewport` 缩放换算），标志跟着静止的截图走，页面滚动、内层容器滚动、缩放一概不影响位置；不要再加回“先把整屏图解码好、再用 `initialResults` 塞进容器”的预解码路径，那会重新分叉出第二套显示逻辑。点绿框或绿点都算选中该码（整个绿框区域可点，不必点中小圆点），通知切到该码、但只摘掉它的圆点，绿框留着标出这个码已经看过（面板与网页图片走 `useCodePicker.pick` 写 `pickedFlags`，截图容器走 `ScreenshotSession.markPicked(index)`：两边都按同一份结果列表记下标，别改成删结果或只删渲染出来的框），没点过的继续可点，全点完后由宿主收掉标记层；空白点击由 composable 在 `document` 捕获阶段判断（不铺全屏透明层，面板按钮照常可用），通知窗口刚被这次点击关掉时保留绿点，只有窗口**宽度**变化会让页面重排时才收起（带 `measureRect` 的锚点不收起，重测一次即可跟住新排版）。**全屏扫描的截图浮层随结果通知收起**：结果通知结束时后台会向发起通知的标签页转发 `notificationResolved`（`popupHost` 记录的 `sourceTabId`），内容脚本的 `onNoticeDone` 据此清标记；单码的通知就是结果展示，关掉即收起浮层，多码则等最后一个绿点被点掉的条通知结束后再收起（`closeShotOnNotice`，点选中间的通知不会误收），框选没扫到时保留浮层继续框选。
- **扫描效果**：只改 [qrScanner.ts](./src/services/qrScanner.ts)。ZXing 用深路径导入（`@zxing/library/esm/core/...`），别改成包根导入；摄像头逐帧只走 `decodeCameraFrame`，换 `decodeAllFromImageData` 会卡预览；一维码命中后必须过 `isOneDResultConfirmed` 核对相邻行（文字行也能凑出校验位合法的条码，少了这层会把正文认成条形码），批量扫描里未通过的结果只遮罩不中断，否则一处误判会挡住同图真正的条码。二维码整图/码面矩形都没扫出时会把整图缩到 `QR_DOWNSCALE_DIMENSION` 再扫一遍（模块过大时 ZXing 的定位点会漏检），命中坐标靠 `Candidate.scale` 换回原图，这层别删。
- **popup 里扫描**：扩展商店等注入不了内容脚本的页面由 popup 承接扫描，入口 [popup/main.ts](./src/entrypoints/popup/main.ts) 在 `mount('#app')` 前先读 `qrNotification`，让窗口首帧就是通知。扫描期间 popup 先显示待扫描图片并在图上播 region 扫描动画（`useScanAnimation` + `measureImageRect`），动画淡出、图片收起后才换成结果通知——窗口按图片成型，别改回只闪一个空通知或整屏动画。这类页面的图片加载失败通知里也给「框选扫描」（`requestFrameScan`），后台按三级降级执行：本页没有内容脚本就截视口开 `capture.html?frame=1`，成功后才让 popup 让出焦点。
- **摄像头扫码**：右键菜单的“摄像头扫码”（`scanCamera`）直接开 `upload.html?camera=1`；面板本体仍只在 `ScanPanel.vue`，不要塞进 popup（失焦即关）。内容脚本也能 `getUserMedia`，但受页面安全上下文与 `Permissions-Policy` 约束、权限归页面源，故浮层失败时降级 `upload.html?camera=1`；媒体流与取帧在 `useCameraScan.ts`，命中即停，用户点“继续扫描”恢复。新增输入方式只实现一个“产出图像”的源，别拆第二套面板/扫描流程。
- **通知外观/交互**：`NotifyHost.vue` + `useNotify.ts`；跨进程字段同步改 `popupNotice.ts` 与 `usePopupNoticeHost.ts`。popup 里的通知卡片（`.qr-notify-root--embedded`）始终带底部投影但不开圆角：弹窗窗口按内容尺寸成型会自然裁掉投影，只有用标签页打开 popup 页面时才浮在页面背景上；圆角会让四个角漏出投影。popup 里通知收起时面板会立刻回到流里，退场中的通知靠 `#app > .qr-notify-root--embedded.qr-notify-fade-leave-active` 绝对定位叠在面板上淡出——不这样两者会并排铺开把弹窗撑宽再缩回。没有二维码可展示时（打开即扫描的场景）要在通知还在画面上就 `window.close()`，等淡出结束再关会先露一帧空窗口。popup 自己的多码扫描也走 `useCodePicker`：扫到多条时先弹“发现多个码”提示，关掉后再把预览图留在窗口里叠绿点，点绿点才弹该条通知；点完最后一条由 `finishPickingIfDone` 收起预览图，点选期间靠 `picking` 让空窗兜底不关窗口。
- **新增 UI 文案**：`public/_locales/en/messages.json` 与 `zh_CN/messages.json` 同时添加，代码里统一 `browser.i18n.getMessage(key)`（各入口有本地 `t()` 包装）。
- **权限 / manifest / 图标**：只改 [wxt.config.ts](./wxt.config.ts)。不要声明 `clipboardRead` / `clipboardWrite`：图片只从 paste/拖放事件读，文本复制在点击手势里，失败用 `execCommand('copy')` 兜底。
- **截图**：视图层 `ScreenshotOverlay.vue`，流程统一在 `useScreenshotScan.ts`：普通页面与 SVG / PDF 兜底页（[capture/App.vue](./src/entrypoints/capture/App.vue)）都用同一条“截图 → 整屏/框选 → 解码 → 标绿点 → 点选”的流程，页面侧只负责给 `src`（截好的视口图）或让容器自己截。扫描屏幕（`scanScreen`）就是自动整屏框选一次，不要再拆出独立的整屏结果路径，也不要改回在页面上叠绿框。

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

- **大图扫描阻塞 UI**：先播扫描动画（`beforeNotice` 等首帧），再 `await new Promise(r => setTimeout(r, 50))` 后解码；扫描期间没有单独的通知，靠动画表示“正在扫描”。
- **提示分两段，动画在取图之后**：网络取图慢于 150ms 才提示“正在获取图片...”（`notifyFetching`），图就绪后由扫描动画接替（`beforeNotice`）；本地图 / 截图不需要 `notifyFetching`。这条提示超过 `FETCH_TIMEOUT_MS`（5 秒）还没取到图，就换成建议改用扫描屏幕的通知，图片之后到达仍继续扫描。
- **跨域 / 防盗链图片**：直接 fetch 常失败，失败提示里保留“框选扫描”出口（用户框住页面上那张图，比整屏再扫一遍更容易命中）；不要再加“跨域可能稍慢”通知，与“正在获取图片...”重复。
- **同源重定向到 CDN**：如 GitHub 的 `/owner/repo/raw/...` 302 到 `raw.githubusercontent.com`，`isSameOrigin` 只看跳转前地址，Chrome 因此判 canvas 被污染。`loadImageDataFromUrl` 捕获污染错误后自动改走后台代理，这层兜底不能删；`fetchViaProxy` 也别改回只在跨域时传。
- **`file://` 页面**：Firefox 扩展页/后台无法 fetch，但内容脚本能读已渲染图片画到 canvas，失败再回退截取视口。
- **通知竞态与清理**：后台 `popupHost`（[popupHost.ts](./src/services/popupHost.ts)）打开窗口期间用 `opening` / `POPUP_OPEN_GRACE` 防丢通知，靠自增 `id` 做 `clearIfCurrent`；popup 断开连接时后台删 `qrNotification`，避免下次重复弹出。`finish` 用 `lastFinishedId` 去重：popup 点完通知立刻关窗，断开事件可能早于它发来的 `notificationResolved`，同一条通知会收尾两次，把点选后剩下的绿框一起清掉。都不要简化。
- **页面全局 CSS 会泄漏进注入 UI**：如 `example.com` 的 `svg { margin: -2.75em auto 0; opacity: .55 }` 会把图标顶到按钮外；新增图标时在 `.qr-shot` / `.qr-notify-root` / `.qr-picker-icon` 上声明完整 `margin` 与 `opacity`。
- **独立 SVG/XML 文档不要挂 integrated UI**：直接打开的 `.svg`（如 `https://app.trakt.tv/favicon.svg`）里 `document.createElement('div')` 没有 `.style`，`createIntegratedUi` 会在 `applyPosition` 设 `overflow` 时抛 `Cannot set properties of undefined`。`content/index.ts` 已在 `main()` 开头做能力检查跳过这类文档，扫描交 popup / `capture.html`，不要删。
- **扩展页收不到 `tabs.sendMessage`**：`capture.html` 这类扩展页在自己的标签页里时，`browser.tabs.sendMessage` 直接报 `Receiving end does not exist`（Chrome MV3 实测），所以内容脚本那套消息推不进扩展页。需要给扩展页下发动作（如通知里的「框选扫描」）时，由页面挂载时 `runtime.connect({ name: 'extensionPage' })` 连一个端口，后台用 `sendExtensionPageAction()` 按标签页 id 推回去；关掉端口就推不到了，别改回 `tabs.sendMessage`。
- **开发时固定图标**：未打包扩展的 pin 只在内存里，写 `.wxt/dev-profile/.../Preferences` 的 `extensions.pinned_extensions` 无效；只能由 `.dev/pin-dev-extension.mjs` 运行时调 `chrome.developerPrivate.updateExtensionConfiguration`。改这段前先用 CDP 实测。
- **Chrome/Edge 的 popup 在 Linux 上打不了中文**：Chromium 的扩展弹窗是独立原生窗口，Linux 下 ibus/fcitx 挂不上去，输入框里只能输英文（Firefox 正常，同一份 `popup.html` 用标签页打开也正常）。这是浏览器层面的限制，改焦点处理、composition 事件或 `value` 绑定都不会有效果，别为此加平台探测；需要中文输入时把扩展页当标签页打开，或先把文字复制好再粘贴。
- **开发端口号变化**：开发时使用的端口号变化时，浏览器可能会无法加载最新版本的扩展。需要卸载旧扩展再重新加载。端口写死在 [wxt.config.ts](./wxt.config.ts) 里就是为了不让它变：只写 `dev.server.strictPort` 而不给 `port` 时 WXT 会从 3000 往后找 3001-3010，第二个 dev 实例静默落到新端口并把 `.output/<browser>-mv3-dev` 的页面入口改写成新端口，已在浏览器里跑的扩展随即加载不到 popup 脚本（弹窗空白、通知不出来，但右键菜单照常）。

## 完成标准

1. `pnpm compile` 通过。
2. 新增文案在 `en` / `zh_CN` 两个 locale 中都存在。
3. 不夹带无关修改；提交信息简洁说明用户可见变化。

## 提交标准

每轮对话后都提示用户是否提交更改。

涉及多会话的更改时，优先提交自己对话中的更改，再问用户是否分批次提交其他会话的更改。
