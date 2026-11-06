---
description: "popup 面板与二维码面板：main.ts 先读通知、二维码热区指针规则与右键彩蛋、抽屉 min-width、多码点选收尾、Linux 下输入法限制。Use when: 改 popup 入口或 QrCodePanel，或排查弹窗先闪二维码、右键没有「扫描图片」、窗口被撑宽。"
applyTo:
  - "src/entrypoints/popup/**"
  - "src/components/QrCodePanel.vue"
---

# popup

- `main.ts` 必须在 `mount` 前先读 `qrNotification`，否则窗口先按二维码面板成型再收缩。
- 二维码热区里的 `.qr-panel-toggle` 只给键盘、`pointer-events: none`：否则右键命中的是按钮而不是 `<img>`，`contexts: ['image']` 的「扫描图片」不会出现；在 popup 自己的码上右键走 `scanPopupQr` 彩蛋，用 `flashText` 而不是通知（尺寸不同会重排白闪）。
- 抽屉按钮要 `min-width: 0`，否则英文长文案撑破 220px 面板。
- 多码扫描：先弹「发现多个码」，关掉后留预览图叠绿点，点完最后一条由 `finishPickingIfDone` 收尾；点选期间靠 `picking` 让空窗兜底不关窗。

# 平台限制

Chrome / Edge 的 popup 在 Linux 上打不了中文：扩展弹窗拿不到输入法，改焦点 / composition 都无效，别为此加平台探测；需要中文时把扩展页当标签页打开。
