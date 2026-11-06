# AGENTS.md

给 AI Agent 的项目认知，用户可见说明见 [README.md](./README.md)。

**WXT + Vue 3 + TS** 跨浏览器二维码扩展（Chrome / Edge / Firefox）：生成二维码（当前页 / 选中文本），扫描二维码与一维条形码（网页图片 / 截图 / 本地图片 / 剪贴板），以及截图与框选重扫。

命令、端口、manifest、目录结构、样式细节以 [package.json](./package.json)、[wxt.config.ts](./wxt.config.ts)、[.dev/](./.dev/) 和源码注释为准;

- 文案在 `public/_locales/en` 与 `zh_CN` 成对添加;

## 架构

- 入口：background（注册事件与右键菜单）、content（全站注入 UI）、popup、upload（`?camera=1` 摄像头）、capture（截视口扫描，`?frame=1` 框选）。后台能力拆在 `services/background/`，其余共用逻辑在 `services/`，UI 在 `components/`，流程在 `composables/`。
- 唯一入口不要分叉：扫描只走 `recognizeImage`，截图扫描只走 `useScreenshotScan`，扫描面板只有 `LocalScanPanel`，二维码 SVG 只由 `qrCode.ts` 生成。新增输入方式只实现一个“产出图像”的源。

## 降级链（内容脚本优先，逐级退到扩展页）

- 网页图片 → 内容脚本取图 → 注入不了交 popup 取图 → 取图失败给「框选扫描」。
- 扫描屏幕 → 内容脚本截视口走截图流程 → 不可用（独立 SVG、PDF 阅读器）时后台 `captureVisibleTab` 开 `capture.html`。
- 框选 → 内容脚本浮层 → 扩展页经端口推回同一张截图换可框选层 → `capture.html?frame=1`。
- 相机与本地图片 → 同一个 `upload.html` 扫码面板，进入后由面板内的源切换选择打开相机或上传图片（popup 失焦即关，内容脚本受页面权限限制）。

## 分文件的坑

按文件绑定的细节在 [.github/instructions/](./.github/instructions/)，改到匹配文件会自动带上；**只读代码时不会注入**，碰到下面这些区域请主动打开对应文件：

| 区域 | 文件 |
| --- | --- |
| 解码、坐标换算、取图代理 | [scan.instructions.md](./.github/instructions/scan.instructions.md) |
| 内容脚本注入、绿框与点选 | [content.instructions.md](./.github/instructions/content.instructions.md) |
| 截图浮层、capture 页 | [screenshot.instructions.md](./.github/instructions/screenshot.instructions.md) |
| 通知协议、popup 宿主 | [notice.instructions.md](./.github/instructions/notice.instructions.md) |
| popup 面板、二维码面板 | [popup.instructions.md](./.github/instructions/popup.instructions.md) |
| 发布、商店提交与描述长度 | [release.instructions.md](./.github/instructions/release.instructions.md) |


## 开发调试

对话过程中用户大概率已打开 pnpm dev, Agent 调试时可直接复用该 dev server, 不需要自行打开新的 dev server。