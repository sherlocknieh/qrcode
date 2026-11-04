import type { NotifyIcon, NotifyResultItem } from '@/composables/useNotify';

// 页面通知统一转发给 popup 显示, 该键保存 popup 尚未展示的最新一条通知
export const POPUP_NOTICE_KEY = 'qrNotification';

// open/copy 由 popup 直接执行; screenScan / frameScan 需要 popup 通知当前页面
// 重新截屏扫描 (整屏 / 框选)
export type PopupNoticeAction =
    | { kind: 'open'; value: string }
    | { kind: 'copy'; value: string }
    | { kind: 'screenScan' }
    | { kind: 'frameScan' };

// 可跨进程传递的通知参数: didOpen 等函数无法序列化, 用 loading 标记加载状态
export interface PopupNoticeOptions {
    toast?: boolean;
    icon?: NotifyIcon;
    title?: string;
    text?: string;
    items?: NotifyResultItem[];
    showCloseButton?: boolean;
    showCancelButton?: boolean;
    confirmButtonText?: string;
    cancelButtonText?: string;
    extraButtonText?: string;
    // 显示加载动画
    loading?: boolean;
}

export interface PopupNoticePayload {
    options: PopupNoticeOptions;
    confirmAction?: PopupNoticeAction;
    cancelAction?: PopupNoticeAction;
    extraAction?: PopupNoticeAction;
    // 独立扫描页 (capture.html) 使用: 通知结束后关闭发起它的标签页,
    // 符合"在临时标签页里扫描完就收摊"的预期
    closeOriginTab?: boolean;
}

export interface PopupNoticeRecord extends PopupNoticePayload {
    id: number;
    // 通知结束后要关闭的标签页, 仅在 closeOriginTab 为 true 时记录
    closeTabId?: number;
}

// 交给 popup 显示; 返回 false 表示 popup 不可用, 调用方应回退到页面内通知
export async function showPopupNotice(payload: PopupNoticePayload): Promise<boolean> {
    try {
        const response = await browser.runtime.sendMessage({ action: 'showNotification', payload });
        return response?.success === true;
    } catch {
        return false;
    }
}
