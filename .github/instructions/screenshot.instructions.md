---
description: "截图浮层与 capture 页：扫描屏幕就是自动整屏框选一次、没扫到退回纯框选态、退出与动画规则、浮层与通知的联动边界。Use when: 改 ScreenshotOverlay、useScreenshotScan、useScreenshot 或 capture 入口，或排查截图重扫、浮层不收起。"
applyTo:
  - "src/components/ScreenshotOverlay.vue"
  - "src/composables/useScreenshotScan.ts"
  - "src/composables/useScreenshot.ts"
  - "src/entrypoints/capture/**"
---

# 截图浮层

- 扫描屏幕 = 自动对整屏框选一次，不要另拆一条「先整图解码再塞结果」的路径，否则又分叉出第二套显示逻辑。
- 没扫到自动退回纯框选态：整页扫描的空结果通知不给「确定」，只留「尝试框选扫描」。退出只看手势、与通知是否还开着无关：单击（没拖出选区）或 Esc 退出（内容脚本收起截图浮层，capture 页关掉自己），拖框则继续扫。也正因如此，popup 被这次点击/拖动顺手关掉不会收掉浮层。
- 动画传 `mask: false`，免得与容器压暗叠成黑。
- 浮层不跟通知走：`notificationResolved` 只清网页图片标记，收起浮层由各自的收尾逻辑负责。
