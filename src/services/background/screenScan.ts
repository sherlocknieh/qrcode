import type { ExtensionPage } from '@/services/background/extensionTabs';
import { storageArea } from '@/services/storage';

// 后台截取的视口图, 由 capture.html 读取后立即删除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

export interface ScreenScanOptions {
    openExtensionPage: (path: ExtensionPage, originTabId?: number) => Promise<boolean>;
    // 内容脚本可能未注入 (PDF、SVG 等), 统一处理发送异常与回执
    tryContentAction: (tabId: number | undefined, action: string) => Promise<boolean>;
}

export interface ScreenScan {
    // 截取当前视口 (必须在后台调用, 否则会触发屏幕共享提示并压缩视口)
    capture: (windowId?: number) => Promise<string>;
    // 截视口后在新标签页直接扫描整图
    show: (originTabId?: number, windowId?: number) => Promise<boolean>;
    // 扫描屏幕: 内容脚本优先, 不可注入时退回 show
    request: (tabId: number, windowId?: number) => Promise<boolean>;
}

// 直接打开的 SVG 是 XML 文档, 内容脚本不会注入, 截图类操作需要截取视口后走扩展页面。
// 兜底交给 popup 会受其窗口尺寸限制, 因此截图与整屏扫描统一在新标签页完成。
export const isSvgDocumentUrl = (url?: string) => {
    if (!url) return false;
    try {
        return new URL(url).pathname.toLowerCase().endsWith('.svg');
    } catch {
        return false;
    }
};

export const createScreenScan = (
    { openExtensionPage, tryContentAction }: ScreenScanOptions,
): ScreenScan => {
    const capture = (windowId?: number): Promise<string> => windowId == null
        ? browser.tabs.captureVisibleTab({ format: 'png' })
        : browser.tabs.captureVisibleTab(windowId, { format: 'png' });

    // originTabId 用于关闭 capture 页时切回来源页面, 否则浏览器会切到相邻标签
    const show = async (originTabId?: number, windowId?: number): Promise<boolean> => {
        let dataUrl: string;
        try {
            dataUrl = await capture(windowId);
        } catch (error) {
            // 截图失败不再弹通知: 最常见的原因是标签页没有 activeTab 授权,
            // 调用方只拿到 false, 原因留在控制台供排查
            console.warn('[qrcode] 截取视口失败:', error);
            return false;
        }
        // 截图体积较大, 交给扩展页面读取后立即清除
        await storageArea().set({ [CAPTURE_IMAGE_KEY]: dataUrl });
        // capture 页只做整图扫描, 不再提供框选
        return openExtensionPage('/capture.html', originTabId);
    };

    // 扫描屏幕: 不做框选, 由内容脚本直接截取视口并扫描整图;
    // 无法注入内容脚本的页面 (如 Firefox 内置 PDF 阅读器) 由后台截取视口后
    // 在新标签页 (capture.html) 直接扫描整图, 与 SVG 页面保持一致。
    // 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用
    const request = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, 'scanScreen')) return true;
        return show(tabId, windowId);
    };

    return { capture, show, request };
};
