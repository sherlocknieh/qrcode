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

// 网页图片扫描: 优先交给内容脚本, 在页面上播扫描动画并叠绿框定位;
// 注入不了内容脚本的页面 (扩展商店页, data:image/*页面、独立 SVG、Firefox 新标签页) 退回 popup 取图,
// 只是没有动画与绿框, 直接弹结果通知
export const requestWebImageScan = async (
    tabId?: number,
    imageUrl?: string,
    pageUrl?: string,
): Promise<boolean> => {
    // popup 里右键的是它自己生成的那张二维码, 没有标签页可以交付;
    // 若继续走取图流程会把 popup 再打开一次, 所以只让 popup 弹一句提示
    if (pageUrl?.split(/[?#]/)[0] === browser.runtime.getURL('/popup.html')) {
        void browser.runtime.sendMessage({ action: 'scanPopupQr' }).catch(() => { });
        return true;
    }
    if (!imageUrl) return false;
    if (await sendTabAction(tabId, 'scanWebImage', { imageUrl })) return true;
    return sendImageToPopup(imageUrl).catch(() => false);
};

// 扫码面板只在扩展页里可用: popup 失焦即关闭, 内容脚本又受页面自身摄像头权限约束。
// 相机与上传图片都在同一个面板里, 由面板内的源切换决定, 入口只有这一个
export const openScanPanel = async (originTabId?: number) =>
    openExtensionPage('/upload.html', await resolveActiveTabId(originTabId));
