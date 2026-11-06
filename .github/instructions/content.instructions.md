---
description: "内容脚本注入与绿框点选：独立 SVG/XML 文档的能力检查、页面 CSS 泄漏隔离、anchor/measureRect 锚点、deferResults 与多码点选规则。Use when: 改 content 入口、useCodePicker、ScanMarks、overlayHost、imageRect，或排查注入报错、绿框错位、点选提前收起。"
applyTo:
  - "src/entrypoints/content/**"
  - "src/composables/useCodePicker.ts"
  - "src/components/ScanMarks.vue"
  - "src/components/ScanOverlay.vue"
  - "src/services/overlayHost.ts"
  - "src/services/imageRect.ts"
---

# 注入边界

- 独立 SVG / XML 文档不要挂 integrated UI：直接打开的 `.svg` 里 `document.createElement('div')` 没有 `.style`，`createIntegratedUi` 会在设 `overflow` 时抛错。`content/index.ts` 开头的能力检查不能删，这类页面的扫描交 popup / `capture.html`。
- `file://` 页面：Firefox 扩展页 / 后台无法 fetch，内容脚本读已渲染图片画 canvas，失败回退截取视口。
- 页面全局 CSS 会泄漏进注入 UI（如 `svg { margin: -2.75em auto 0 }` 会把图标顶到按钮外）：新增图标时在 `.qr-shot` / `.qr-notify-root` / `.qr-picker-icon` 上声明完整 `margin` 与 `opacity`。

# 绿框与点选

- 宿主只给 `anchor`（图像画在视口哪块矩形），可按需带 `measureRect`：网页图片必须传，蓝框每次重算都取图片实时位置——只按滚动差量平移的话，固定不随页面滚动的图片上蓝框会随滚动漂移。
- `deferResults` 暂缓结果通知，蓝框自己叠：多码只弹一条「发现多个码」，点某个码才逐条出通知；点开过的只摘圆点、别删结果；点已看过的框或单码框 = 看完退出。空白点击在 `document` 捕获阶段判断，通知还开着时留到下一次点击。
- 内容相同的码有几份返回几份、各自圈出（解码层只合并「内容相同且包围盒重叠」的），通知列表按码型 + 内容去重并注明。
