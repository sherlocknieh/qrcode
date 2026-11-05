import { createApp } from 'vue';
import App from './App.vue';
import { POPUP_NOTICE_KEY, type PopupNoticeRecord } from '@/services/popupNotice';
import { storageArea } from '@/services/storage';

// popup 窗口的高度跟着文档高度走, 而第一帧就决定了窗口第一次成型的大小.
// 扩展商店这类注入不了内容脚本的页面只能由 popup 扫描, 通知也在 popup 里展示:
// 若照常先挂载二维码面板, 窗口会先按面板高度开出来, 读到通知后再收缩, 看着就是猛地缩一下.
// 因此挂载前先把待展示的通知读出来交给 App, 首帧渲染的就是通知, 窗口一次定成通知高度.
async function readPendingNotice(): Promise<PopupNoticeRecord | undefined> {
    try {
        const stored = await storageArea().get(POPUP_NOTICE_KEY);
        return stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
    } catch {
        // 存储不可用时照常按二维码面板开窗, 不影响 popup 的常规功能
        return undefined;
    }
}

void readPendingNotice().then((pendingNotice) => {
    createApp(App, { pendingNotice }).mount('#app');
});
