import { closeTabAndReturn } from '@/services/background/extensionTabs';
import { openLocalScanPanel } from '@/services/background/scanEntry';
import { captureVisibleTab, requestFrameScan, requestScreenScan } from '@/services/background/screenScan';
import { popupHost } from '@/services/popupHost';

// 后台消息路由: 内容脚本与 popup 发来的请求都汇总在这里, 入口文件只把监听器挂上。
// 每个 action 独立处理, 需要异步回执的返回 true 保持消息端口开启
export const handleBackgroundMessage = (
    request: any,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response: any) => void,
): boolean => {
    // 全屏扫描的绿点被点空白处收起前先问一句: 通知窗口是否还开着。
    // 开着说明这一下点击是去关 popup 的, 内容脚本会保留绿点等下一次点击
    if (request.action === 'popupNoticeOpen') {
        sendResponse({ success: true, open: popupHost.isOpen() });
        return false;
    }
    // 页面通知转发到 popup; 独立扫描页会带上 closeOriginTab, 记录发起它的标签页
    if (request.action === 'showNotification') {
        popupHost.showNotification(request.payload, sender.tab?.id)
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // popup 已展示通知, 清理待展示内容 (需要时一并关闭发起它的标签页)
    if (request.action === 'notificationResolved') {
        void popupHost.finish(request.id);
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
        closeTabAndReturn(tabId)
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
            .then(windowId => captureVisibleTab(windowId))
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
                return requestScreenScan(tab.id, tab.windowId, tab.url);
            })
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // 通知里的"框选扫描": 图片扫描失败, 由页面打开框选工具让用户自己选一块
    // (截图扫描自己的结果层就能继续框选, 不再需要这个入口)。
    // 分发细节 (内容脚本 → 扩展页端口 → 截视口截图页) 与右键菜单共用 requestFrameScan
    if (request.action === 'requestFrameScan') {
        requestFrameScan()
            .then(success => sendResponse({ success }))
            .catch(() => sendResponse({ success: false }));
        return true;
    }
    // popup 展开面板里的"相机": 扫码面板只能在扩展页运行, 由后台打开 upload.html,
    // 并记录来源页以便关闭后切回; 图片上传在面板内切换, 不再单独开页面
    if (request.action === 'openLocalScanPanel') {
        openLocalScanPanel(sender.tab?.id)
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
