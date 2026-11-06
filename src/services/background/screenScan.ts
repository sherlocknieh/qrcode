import { openExtensionPage, sendExtensionPageAction } from '@/services/background/extensionTabs';
import { resolveActiveTabId, sendTabAction } from '@/services/messaging';
import { popupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';

// 后台截取的视口图, 由 capture.html 读取后立即删除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// 直接打开的 SVG 是 XML 文档, 内容脚本不会注入, 要跳过内容脚本直接截视口
const isSvgDocumentUrl = (url?: string) => {
    if (!url) return false;
    try {
        return new URL(url).pathname.toLowerCase().endsWith('.svg');
    } catch {
        return false;
    }
};

// 截取当前视口: 必须在后台调用, 否则会触发屏幕共享提示并压缩视口
export const captureVisibleTab = (windowId?: number): Promise<string> => windowId == null
    ? browser.tabs.captureVisibleTab({ format: 'png' })
    : browser.tabs.captureVisibleTab(windowId, { format: 'png' });

// 截视口并落盘: capture.html 读取后立即清除
const storeViewportCapture = async (windowId?: number): Promise<boolean> => {
    try {
        const dataUrl = await captureVisibleTab(windowId);
        // 截图体积较大, 交给扩展页面读取后立即清除
        await storageArea().set({ [CAPTURE_IMAGE_KEY]: dataUrl });
        return true;
    } catch (error) {
        // 截图失败不再弹通知: 最常见的原因是标签页没有 activeTab 授权,
        // 调用方只拿到 false, 原因留在控制台供排查
        console.warn('[qrcode] 截取视口失败:', error);
        return false;
    }
};

// 截视口后在新标签页直接扫描整图。
// 兜底交给 popup 会受其窗口尺寸限制, 所以截图类降级统一走 capture.html;
// originTabId 用于关闭 capture 页时切回来源页面, 否则浏览器会切到相邻标签
export const showScreenScan = async (originTabId?: number, windowId?: number): Promise<boolean> => {
    if (!await storeViewportCapture(windowId)) return false;
    // capture 页先整屏扫一次, 扫完还能在截图上接着框选
    return openExtensionPage('/capture.html', originTabId);
};

// 框选扫描的兜底: 注入不了内容脚本的页面 (扩展商店、独立 SVG、PDF 阅读器)
// 也先截一张视口图, 打开可框选的截图页让用户自己框住要看的那块。
// 截视口必须带来源页所在的窗口, 否则可能落到 popup 自己那一窗
export const showFrameScan = async (originTabId?: number): Promise<boolean> => {
    const windowId = originTabId == null
        ? undefined
        : await browser.tabs.get(originTabId).then((tab) => tab.windowId).catch(() => undefined);
    if (!await storeViewportCapture(windowId)) return false;
    return openExtensionPage('/capture.html?frame=1', originTabId);
};

// 框选扫描的分发 (右键菜单与通知里的"框选扫描"共用):
// 内容脚本优先, 在页面上直接拖框; 扩展页 (capture.html) 收不到 tabs.sendMessage,
// 走它自己连上来的端口; 都够不着 (扩展商店、独立 SVG、PDF 阅读器等) 就截张视口图开可框选的截图页。
// 右键菜单可能在 popup / devtools 里触发而没有标签页, 由 resolveActiveTabId 兜底
export const requestFrameScan = async (tabId?: number): Promise<boolean> => {
    const targetTabId = await resolveActiveTabId(tabId);
    if (targetTabId == null) return false;
    const delivered = await sendTabAction(targetTabId, 'frameScan')
        || sendExtensionPageAction(targetTabId, 'frameScan')
        || await showFrameScan(targetTabId);
    // 框选要在这一页继续扫, 别让这条通知收尾时把该页一起关掉
    if (delivered) await popupHost.keepTab(targetTabId);
    return delivered;
};

// 扫描屏幕要用到标签页 id、窗口与地址, 三者必须来自同一个标签页:
// 右键菜单在 popup / devtools 这类没有普通标签页的宿主里触发时 tab 为 undefined 或
// id 为 TAB_ID_NONE(-1), 由这里统一回落到当前活动标签页, 调用方不必各自判空
const resolveScanTarget = async (
    tabId?: number,
    windowId?: number,
    url?: string,
): Promise<{ tabId: number; windowId?: number; url?: string } | undefined> => {
    if (tabId != null && tabId >= 0) return { tabId, windowId, url };
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return undefined;
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
};

// 扫描屏幕: 先由内容脚本截取视口并扫描整图 (截图上还能继续框选);
// 内容脚本不可用时 (独立 SVG、Firefox 内置 PDF 阅读器) 由后台截取视口后
// 在新标签页 (capture.html) 走同一条流程。
// 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用
export const requestScreenScan = async (
    tabId?: number,
    windowId?: number,
    url?: string,
): Promise<boolean> => {
    const target = await resolveScanTarget(tabId, windowId, url);
    if (!target) return false;
    if (!isSvgDocumentUrl(target.url) && await sendTabAction(target.tabId, 'scanScreen')) return true;
    return showScreenScan(target.tabId, target.windowId);
};
