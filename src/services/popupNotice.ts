import { notifyState } from '@/composables/useNotify';
import type { NotifyIcon, NotifyResultItem } from '@/composables/useNotify';

// 页面通知统一转发给 popup 显示, 该键保存 popup 尚未展示的最新一条通知
export const POPUP_NOTICE_KEY = 'qrNotification';

// open/copy 由 popup 直接执行; screenScan / frameScan 需要 popup 通知当前页面重新截屏扫描 (整屏 / 框选)
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
    // 列表先收起, 等用户点"显示全部"再摊开 (多码提示用)
    itemsCollapsed?: boolean;
    showCloseButton?: boolean;
    showCancelButton?: boolean;
    // 主按钮: 只承载真实动作 (打开链接 / 复制内容), 不写文案就不放这个按钮
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
    // 发起通知的标签页: 通知结束时通知它收尾 (清扫描标记、收起全屏扫描的截图浮层)
    sourceTabId?: number;
}

// 还有通知在等用户处理: 本页兜底通知开着, 或 popup 通知窗口开着 (刚被这次点击点掉也算,
// 后台用一段关闭宽限兜住)。宿主据此把这次空白点击只当成"消通知", 不动扫描现场
export async function isNoticeShowing(): Promise<boolean> {
    if (notifyState.open) return true;
    try {
        const response = await browser.runtime.sendMessage({ action: 'popupNoticeOpen' });
        return response?.open === true;
    } catch {
        return false;
    }
}

// 交给 popup 显示; 返回通知 id, null 表示 popup 不可用, 调用方应回退到页面内通知
export async function showPopupNotice(payload: PopupNoticePayload): Promise<number | null> {
    try {
        const response = await browser.runtime.sendMessage({ action: 'showNotification', payload });
        return response?.success === true ? (response.id as number) : null;
    } catch {
        return null;
    }
}

// 收起一条还在等用户处理的过程提示 (如正在下载图片): 后台删掉记录并让 popup 自行关窗,
// 之后的扫描结果通知会重新打开 popup。
// 与 notificationResolved 不同: 这是宿主自己撤掉的提示, 不算用户处理完, 不通知来源页收尾
export async function dismissPopupNotice(id: number): Promise<void> {
    try {
        await browser.runtime.sendMessage({ action: 'dismissNotification', id });
    } catch {
        // 后台不可用时无需额外提示: 这条提示本身只是过程说明
    }
}
