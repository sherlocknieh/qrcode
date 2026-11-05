import type { PageAction } from '@/services/background/pageAction';
import { isSvgDocumentUrl } from '@/services/background/screenScan';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';

// Chrome/Edge 不支持菜单图标, 用 emoji 前缀提升辨识度; Firefox 已有图标, 不重复添加
type MenuMessageKey = 'scanWebImage' | 'selectionToQR' | 'scanScreen' | 'scanLocalImage' | 'cameraScanTitle';

const IS_FIREFOX = import.meta.env.FIREFOX;

export interface ContextMenusOptions {
    pageAction: PageAction;
    // 选中文字生成二维码
    showQRcode: (text?: string) => void;
    // 页面图片交给 popup 扫描 (内容脚本不可用时的降级)
    showQrFromImagePage: (imageUrl?: string) => void;
    requestScreenScan: (tabId: number, windowId?: number) => Promise<boolean>;
    showScreenScan: (originTabId?: number, windowId?: number) => Promise<boolean>;
    requestLocalImageScan: (tabId?: number) => Promise<boolean>;
    openCameraScan: (originTabId?: number) => Promise<boolean>;
}

export const createContextMenus = (options: ContextMenusOptions) => {
    const { pageAction } = options;

    // Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
    // 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
    const menuIcons = (name: MenuIconName) => IS_FIREFOX
        ? { icons: { 16: getMenuIcon(name) } }
        : {};

    const menuTitle = (key: MenuMessageKey, emoji?: string) => {
        const title = browser.i18n.getMessage(key);
        return IS_FIREFOX || !emoji ? title : `${emoji} ${title}`;
    };

    // 初始化右键菜单
    const add = async () => {
        const pageActionVisible = IS_FIREFOX && await pageAction.isVisible();
        browser.contextMenus.removeAll(() => {
            // 扫描图中二维码
            browser.contextMenus.create({
                id: 'scanWebImage',
                title: menuTitle('scanWebImage', '🔍'),
                contexts: ['image'],
                ...menuIcons('scan'),
            });
            // 选中文字生成二维码
            browser.contextMenus.create({
                id: 'selectionToQR',
                title: menuTitle('selectionToQR', '📝'),
                contexts: ['selection'],
                ...menuIcons('text'),
            });
            // 扫描当前页面可视区域
            browser.contextMenus.create({
                id: 'scanScreen',
                title: menuTitle('scanScreen', '🖥️'),
                contexts: ['page', 'action', 'page_action'],
                ...menuIcons('scanScreen'),
            });
            // 粘贴/上传本地图片扫描
            browser.contextMenus.create({
                id: 'scanLocalImage',
                title: menuTitle('scanLocalImage', '📋'),
                contexts: ['action', 'page_action'],
                ...menuIcons('image'),
            });
            // 打开摄像头扫描
            browser.contextMenus.create({
                id: 'scanCamera',
                title: menuTitle('cameraScanTitle', '📷'),
                contexts: ['action', 'page_action'],
                ...menuIcons('camera'),
            });
            // Firefox 地址栏图标开关
            if (IS_FIREFOX) pageAction.addMenuItem(pageActionVisible);
        });
    };

    const handleClick = (info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) => {
        // 地址栏图标开关
        if (info.menuItemId === 'togglePageAction') {
            void pageAction.toggle();
            return;
        }
        // 选中文字生成二维码
        if (info.menuItemId === 'selectionToQR') {
            options.showQRcode(info.selectionText);
            return;
        }

        // 下面的操作都依赖标签页, 先查询当前前台标签页 ID
        const tabId = tab?.id;
        if (tabId == null) {
            console.warn('tabId is null');
            return;
        }

        // 粘贴/上传本地图片: 请求内容脚本弹出扫描面板, 不可用时回退到独立扩展页
        if (info.menuItemId === 'scanLocalImage') {
            void options.requestLocalImageScan(tabId);
            return;
        }
        // 打开摄像头扫码: 打开以摄像头模式进入的扫描页
        if (info.menuItemId === 'scanCamera') {
            void options.openCameraScan(tabId);
            return;
        }
        // 页面图片二维码扫描, 扫描过程的提示统一由 popup 显示
        if (info.menuItemId === 'scanWebImage') {
            // 此 URL 是包含域名的完整 URL, 无论图片是否用了相对路径
            browser.tabs.sendMessage(tabId, {
                action: 'scanWebImage',
                imageUrl: info.srcUrl,
            }).catch(() => {
                // PDF、SVG 等无法注入内容脚本的特殊页面: 直接把链接传给 popup,
                // 由 popup 完成图片获取和扫描
                options.showQrFromImagePage(info.srcUrl);
            });
            return;
        }
        // 扫描当前页面: 内容脚本直接截取视口并扫描整图, 不可用时回退到独立扩展页
        if (info.menuItemId === 'scanScreen') {
            // SVG 文档同样截取视口后在新标签页直接扫描整图, 避免 popup 窗口裁掉页面内容
            if (isSvgDocumentUrl(tab?.url)) {
                void options.showScreenScan(tabId, tab?.windowId);
                return;
            }
            void options.requestScreenScan(tabId, tab?.windowId);
        }
    };

    return { add, handleClick };
};
