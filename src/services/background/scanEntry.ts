import { openExtensionPage } from '@/services/background/extensionTabs';
import { resolveActiveTabId, sendTabAction } from '@/services/messaging';
import { popupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';

// 把图片交给 popup 扫描: 内容脚本注入不了 (扩展商店页、独立 SVG 等) 的页面里
// 右键图片仍会带 srcUrl 命中菜单, 由这条路径兜底; 截图不走这里, 由 capture.html 承接。
// popup 已打开时它自己会读存储, 不再重复打开
export const sendImageToPopup = async (imageUrl?: string): Promise<boolean> => {
    if (!imageUrl) return false;
    await storageArea().set({ qrImageUrl: imageUrl });
    if (popupHost.isConnected()) return true;
    await popupHost.open();
    return true;
};

// 上传/粘贴图片: 与扫描屏幕的降级策略一致, 内容脚本不可用时退回 upload.html 自主取图
export const requestLocalImageScan = async (tabId?: number): Promise<boolean> => {
    const targetTabId = await resolveActiveTabId(tabId);
    if (await sendTabAction(targetTabId, 'scanLocalImage')) return true;
    return openExtensionPage('/upload.html', targetTabId);
};

// 摄像头只在扩展页里可用: popup 失焦即关闭, 内容脚本又受页面自身摄像头权限约束,
// 因此复用 upload.html 的扫描页, 用 ?camera=1 让页面直接进入摄像头模式
export const openCameraScan = async (originTabId?: number) =>
    openExtensionPage('/upload.html?camera=1', await resolveActiveTabId(originTabId));
