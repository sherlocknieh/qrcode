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
- 整页扫描没扫到：空结果通知不给「确定」，只留「尝试框选扫描」。关掉通知就是放弃这次截图——内容脚本收起截图浮层，capture 页关掉自己；点了框选入口才退回纯框选态继续扫（`frameScan` 到来时会先清掉空结果标记，通知随后收尾也不再收摊）。其余情况退出只看手势：单击（没拖出选区）、Esc 或（浮窗态）点页面外部退出（内容脚本收起截图浮层，capture 页关掉自己），拖框则继续扫。空白点击（单击与点页面外部）与点已看过的灰框同一条收尾，只是灰框会拦下点击：通知还开着时只当是在消通知，popup 被这一下顺手关掉也不会收掉浮层；通知消掉后再点才退出。Esc 不受通知影响。
- 动画传 `mask: false`，免得与容器压暗叠成黑。
- 结果通知不跟浮层走：`notificationResolved` 不会因为扫到结果而收起截图层，收起由各自的收尾逻辑负责（空结果通知例外，见上）。
