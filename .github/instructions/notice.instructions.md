---
description: "通知协议与 popup 宿主：showPopupNotice 降级链、payload 必须可序列化、closeOriginTab/keepTab、opening 与 POPUP_OPEN_GRACE 竞态、扩展页端口推送。Use when: 改 popupNotice/popupHost/NotifyHost/useNotify/useNoticeFallback，或排查通知丢失、重复弹出、关错页面。"
applyTo:
  - "src/services/popupNotice.ts"
  - "src/services/popupHost.ts"
  - "src/services/background/messages.ts"
  - "src/services/background/extensionTabs.ts"
  - "src/composables/useNotify.ts"
  - "src/composables/useNoticeFallback.ts"
  - "src/composables/usePopupNoticeHost.ts"
  - "src/components/NotifyHost.vue"
---

# 通知

- 统一落 popup：`showPopupNotice` → 后台写 `qrNotification` 推送；没开窗则 `pageAction.openPopup` → `action.openPopup` → 页面内 `NotifyHost` 兜底。
- payload 必须可序列化：动作用 `PopupNoticeAction`（`open` / `copy` / `screenScan` / `frameScan` / `dismiss`），不要塞函数。不要为「收起通知」加消息：通知已结束就删记录，popup 无内容时自己关窗，靠下一条通知替换。
- `exitOnDismiss` 是「关掉通知＝退出扫描」：整页扫描没扫到时该提示不给「确定」，`popupHost.finish()` 把它随 `notificationResolved` 一起发给来源页（内容脚本收起截图浮层 / capture 页靠 `closeOriginTab` 关掉自己）；页面内兜底通知则由 `useNoticeFallback` 的 `onExitScan` 就地收起。点「尝试框选扫描」时 `popupHost.keepTab()` 同时摘掉 `closeTabId` 与 `exitOnDismiss`，别把刚要框选的那页收掉。
- `closeOriginTab` 让通知结束后关掉发起页（capture / upload）；点「框选扫描」时后台 `popupHost.keepTab()` 摘掉它，否则会关掉正要框选的那页。
- 竞态：`opening` / `POPUP_OPEN_GRACE` 防丢通知，自增 `id` 做 `clearIfCurrent`，`lastFinishedId` 防重复收尾。popup 断开连接时删 `qrNotification`，否则下次会重复弹出。

# 扩展页通信

扩展页收不到 `tabs.sendMessage`：扩展页挂载时 `runtime.connect({ name: 'extensionPage' })`，后台用 `sendExtensionPageAction` 按标签页 id 推，别改回 `tabs.sendMessage`。
