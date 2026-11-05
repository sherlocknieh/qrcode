import type { ExtensionTabs } from '@/services/background/extensionTabs';
import type { ScanEntry } from '@/services/background/scanEntry';
import type { ScreenScan } from '@/services/background/screenScan';
import type { createPopupHost } from '@/services/popupHost';

// 后台消息路由: 内容脚本与 popup 发来的请求都汇总在这里, 入口文件只把监听器挂上去。
// 每个 action 独立处理, 需要异步回执的返回 true 保持消息端口开启
export interface BackgroundMessagesOptions {
    popup: ReturnType<typeof createPopupHost>;
    tabs: ExtensionTabs;
    scanEntry: ScanEntry;
    screenScan: ScreenScan;
}

export const createBackgroundMessageHandler = ({
    popup,
    tabs,
    scanEntry,
    screenScan,
}: BackgroundMessagesOptions) => (
    request: any,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response: any) => void,
): boolean => {
    // 全屏扫描的蓝点被点空白处收起前先问一句: 通知窗口是否还开着。
    // 开着说明这一下点击是去关 popup 的, 内容脚本会保留蓝点等下一次点击
    if (request.action === 'popupNoticeOpen') {
        sendResponse({ success: true, open: popup.isOpen() });
        return false;
    }
    // 页面通知转发到 popup; 独立扫描页会带上 closeOriginTab, 记录发起它的标签页
    if (request.action === 'showNotification') {
        popup.showNotification(request.payload, sender.tab?.id)
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // popup 已展示通知, 清理待展示内容 (需要时一并关闭发起它的标签页)
    if (request.action === 'notificationResolved') {
        void popup.finish(request.id);
        sendResponse({ success: true });
        return false;
    }
    // 临时扩展页请求关闭自己 (框选取消 / 页面内通知结束), 由后台切回来源页再关闭
    if (request.action === 'closeExtensionTab') {
        const tabId = sender.tab?.id;
        if (tabId == null) {
            sendResponse({ success: false });
            return false;
        }
        tabs.closeAndReturn(tabId)
            .then(() => sendResponse({ success: true }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // 截取当前标签页可见区域: 由后台调用可避免 getDisplayMedia 的屏幕共享提示条压缩页面视口
    if (request.action === 'captureVisibleTab') {
        // 消息可能来自内容脚本 (sender.tab), 也可能来自 popup (无 sender.tab)
        const resolveWindowId = async () => {
            if (sender.tab?.windowId != null) return sender.tab.windowId;
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            return tab?.windowId;
        };
        resolveWindowId()
            .then(windowId => screenScan.capture(windowId))
            .then(dataUrl => sendResponse({ success: true, dataUrl }))
            .catch(error => sendResponse({ success: false, error: error?.message ?? String(error) }));
        return true;
    }
    // popup 点击"改用扫描屏幕"后, 让当前页面重新截取视口扫描;
    // 无法注入内容脚本的页面改为截取视口后在新标签页直接扫描
    if (request.action === 'requestScreenScan') {
        browser.tabs.query({ active: true, currentWindow: true })
            .then(async ([tab]) => {
                if (tab?.id == null) throw new Error('No active tab.');
                return screenScan.request(tab.id, tab.windowId);
            })
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // popup 通知里点"框选扫描": 全屏扫描没扫到码, 由内容脚本打开框选浮层让用户自己选一块
    if (request.action === 'requestFrameScan') {
        browser.tabs.query({ active: true, currentWindow: true })
            .then(async ([tab]) => {
                if (tab?.id == null) throw new Error('No active tab.');
                return scanEntry.tryContentAction(tab.id, 'frameScan');
            })
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // popup 展开面板里的"扫描图片": 与右键菜单共用同一套分发,
    // 优先在当前页开扫描浮层, 内容脚本不可注入时再打开独立扫描页
    if (request.action === 'openImageScan') {
        scanEntry.requestLocalImageScan(sender.tab?.id)
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // 图片扫描浮层里点"从摄像头取图": 摄像头只能在扩展页运行,
    // 由后台打开 upload.html?camera=1, 并记录来源页以便关闭后切回
    if (request.action === 'openCameraScan') {
        scanEntry.openCameraScan(sender.tab?.id)
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // 跨域获取图片数据: 页面侧直接 fetch 会被 CORS 挡住, 由后台带扩展权限请求
    if (request.action === 'fetchImage') {
        fetch(request.url)
            .then(response => response.blob())
            .then((blob) => {
                const reader = new FileReader();
                reader.onload = () => sendResponse({ success: true, dataUrl: reader.result });
                reader.readAsDataURL(blob);
            })
            .catch(error => sendResponse({ success: false, error: error.message }));
    }
    // 保持通道开启, 防止 Error: The message port closed before a response was received.
    return true;
};
