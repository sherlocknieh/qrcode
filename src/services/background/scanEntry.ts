import type { ExtensionPage } from '@/services/background/extensionTabs';
import { storageArea } from '@/services/storage';

// 扫描入口的降级分发: 能在当前页面完成就交给内容脚本, 内容脚本注入不了 (PDF、SVG 等)
// 才退到独立扩展页; 工具栏右键菜单不一定带 tab 参数, 活动标签页也在这里兜底查询。
export interface ScanEntryOptions {
    // 后台侧的 popup 宿主: 图片交接给 popup, 已打开时不再重复打开
    popup: { isConnected: () => boolean; open: () => Promise<void> };
    // 临时扩展页的打开入口
    openExtensionPage: (path: ExtensionPage, originTabId?: number) => Promise<boolean>;
}

export interface ScanEntry {
    // 把图片交给 popup 扫描, 交接不成 (空地址) 返回 false
    sendImageToPopup: (imageUrl?: string) => Promise<boolean>;
    // 内容脚本可能未注入 (PDF、SVG 等), 统一处理发送异常与回执
    tryContentAction: (tabId: number | undefined, action: string) => Promise<boolean>;
    resolveActiveTabId: (tabId?: number) => Promise<number | undefined>;
    // 上传/粘贴图片: 优先在当前页面弹出扫描浮层, 否则退回独立扫描页
    requestLocalImageScan: (tabId?: number) => Promise<boolean>;
    // 摄像头扫码: 只在扩展页面里运行
    openCameraScan: (originTabId?: number) => Promise<boolean>;
}

export const createScanEntry = ({ popup, openExtensionPage }: ScanEntryOptions): ScanEntry => {
    // 把图片交给 popup 扫描: 内容脚本注入不了 (扩展商店页、独立 SVG 等) 的页面里
    // 右键图片仍会带 srcUrl 命中菜单, 由这条路径兜底; 截图不走这里, 由 capture.html 承接。
    const sendImageToPopup = async (imageUrl?: string): Promise<boolean> => {
        if (!imageUrl) return false;
        await storageArea().set({ qrImageUrl: imageUrl });
        if (popup.isConnected()) return true;
        await popup.open();
        return true;
    };

    const tryContentAction = async (tabId: number | undefined, action: string): Promise<boolean> => {
        if (tabId == null) return false;
        try {
            const response = await browser.tabs.sendMessage(tabId, { action }) as { success?: boolean } | undefined;
            return response?.success !== false;
        } catch {
            return false;
        }
    };

    const resolveActiveTabId = async (tabId?: number): Promise<number | undefined> => {
        if (tabId != null) return tabId;
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        return activeTab?.id;
    };

    // 与扫描屏幕的降级策略保持一致: 内容脚本不可用时退回 upload.html 自主取图
    const requestLocalImageScan = async (tabId?: number): Promise<boolean> => {
        const targetTabId = await resolveActiveTabId(tabId);
        if (await tryContentAction(targetTabId, 'scanLocalImage')) return true;
        return openExtensionPage('/upload.html', targetTabId);
    };

    // 摄像头只在扩展页里可用: popup 失焦即关闭, 内容脚本又受页面自身摄像头权限约束,
    // 因此复用 upload.html 的扫描页, 用 ?camera=1 让页面直接进入摄像头模式
    const openCameraScan = async (originTabId?: number) =>
        openExtensionPage('/upload.html?camera=1', await resolveActiveTabId(originTabId));

    return {
        sendImageToPopup,
        tryContentAction,
        resolveActiveTabId,
        requestLocalImageScan,
        openCameraScan,
    };
};
