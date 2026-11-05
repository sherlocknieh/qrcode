// 右键菜单的创建与点击分发

import { openCameraScan, requestLocalImageScan, sendImageToPopup } from '@/services/background/scanEntry';
import { requestScreenScan } from '@/services/background/screenScan';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';
import { popupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';


// 动作: 弹出 popup 窗口展示二维码
const showQRcode = (text?: string) => {
    // 消除文字首尾空白
    const value = text?.trim(); if (!value) return;
    // 把选中文字写入存储
    void storageArea().set({ qrCodeText: value });
    // 打开 popup 弹窗
    void popupHost.open().catch(() => { });
    // popup 会去读存储并生成二维码
};


// 设置右键菜单图标
const IS_FIREFOX = import.meta.env.FIREFOX;
// Firefox 内置支持设置图标
const setMenuIcon = (name: MenuIconName) => IS_FIREFOX ? { icons: { 16: getMenuIcon(name) } } : {};
// Chrome 只能通过在标题前添加 emoji 来充当图标
type MenuMessageKey = 'selectionToQR' | 'scanWebImage' | 'scanScreen' | 'scanLocalImage' | 'scanCamera';
const setMenuTitle = (key: MenuMessageKey, emoji?: string) => {
    const title = browser.i18n.getMessage(key);
    return IS_FIREFOX || !emoji ? title : `${emoji} ${title}`;
};


// 初始化右键菜单
export const addContextMenus = () => new Promise<void>((resolve) => {
    browser.contextMenus.removeAll(() => {
        // 选中文字生成二维码
        browser.contextMenus.create({
            id: 'selectionToQR',
            title: browser.i18n.getMessage('selectionToQR'),
            contexts: ['selection'],
            ...setMenuIcon('text'),
        });
        // 扫描网页图片
        browser.contextMenus.create({
            id: 'scanWebImage',
            title: browser.i18n.getMessage('scanWebImage'),
            contexts: ['image'],
            ...setMenuIcon('scan'),
        });
        // 扫描当前页面可视区域
        browser.contextMenus.create({
            id: 'scanScreen',
            title: setMenuTitle('scanScreen', '🖥️'),
            contexts: ['action', 'page_action'],
            ...setMenuIcon('scanScreen'),
        });
        // 粘贴/上传本地图片扫描
        browser.contextMenus.create({
            id: 'scanLocalImage',
            title: setMenuTitle('scanLocalImage', '📋'),
            contexts: ['action', 'page_action'],
            ...setMenuIcon('image'),
        });
        // 打开摄像头扫描
        browser.contextMenus.create({
            id: 'scanCamera',
            title: setMenuTitle('scanCamera', '📷'),
            contexts: ['action', 'page_action'],
            ...setMenuIcon('camera'),
        });
        resolve();
    });
});


// 处理右键菜单点击事件
export const handleContextMenuClick = async (
    info: Browser.contextMenus.OnClickData,
    tab?: Browser.tabs.Tab) => {
    
    // 选中文字生成二维码
    if (info.menuItemId === 'selectionToQR') {
        showQRcode(info.selectionText);
        return;
    }

    // 扫描网页图片中的二维码
    if (info.menuItemId === 'scanWebImage') {
        const tabId = tab?.id != null && tab.id >= 0 ? tab.id : undefined;
        // 在 popup 窗口里的二维码上右键扫描时, 弹一句彩蛋;
        if (info.pageUrl?.split(/[?#]/)[0] === browser.runtime.getURL('/popup.html')) {
            void browser.runtime.sendMessage({ action: 'scanPopupQr' }).catch(() => { });
            return;
        }
        if (tabId != null) {
            try {
                await browser.tabs.sendMessage(tabId, { action: 'scanWebImage', imageUrl: info.srcUrl });
            } catch {
                // 注入不了内容脚本的页面交给 popup 取图, 只是没有扫描动画和蓝框定位
                // 已知的会有图片且不能注入内容脚本的页面有: 扩展商店页, 独立SVG页面, 火狐新标签页
                await sendImageToPopup(info.srcUrl).catch(() => { });
            }
        }
        return;
    }

    // 粘贴/上传本地图片: 请求内容脚本弹出扫描面板, 不可用时回退到独立扩展页
    if (info.menuItemId === 'scanLocalImage') {
        void requestLocalImageScan(tab?.id);
        return;
    }
    // 打开摄像头扫码
    if (info.menuItemId === 'scanCamera') {
        void openCameraScan(tab?.id);
        return;
    }
    // 扫描当前页面视口: 独立 SVG 由 requestScreenScan 内部跳过内容脚本
    if (info.menuItemId === 'scanScreen') {
        void requestScreenScan(tab?.id, tab?.windowId, tab?.url);
    }
};
