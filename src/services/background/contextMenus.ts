// 处理右键菜单相关的逻辑


import type { PageAction } from '@/services/background/pageAction';
import { isSvgDocumentUrl } from '@/services/background/screenScan';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';
export interface ContextMenusOptions {
    pageAction: PageAction;
    // 选中文字生成二维码
    showQRcode: (text?: string) => void;
    // 页面图片交给 popup 扫描 (内容脚本不可用时的降级)
    sendImageToPopup: (imageUrl?: string) => Promise<boolean>;
    requestScreenScan: (tabId: number, windowId?: number) => Promise<boolean>;
    showScreenScan: (originTabId?: number, windowId?: number) => Promise<boolean>;
    requestLocalImageScan: (tabId?: number) => Promise<boolean>;
    openCameraScan: (originTabId?: number) => Promise<boolean>;
}


// 右键菜单的创建与点击处理
export const createContextMenus = (options: ContextMenusOptions) => {
    const { pageAction } = options;

    const IS_FIREFOX = import.meta.env.FIREFOX;

    // Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
    // 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
    const menuIcons = (name: MenuIconName) => IS_FIREFOX
        ? { icons: { 16: getMenuIcon(name) } }
        : {};

    type MenuMessageKey = 'scanWebImage' | 'selectionToQR' | 'scanScreen' | 'scanLocalImage' | 'cameraScanTitle';

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

    // Chrome 在不属于标签页的页面上传的是 TAB_ID_NONE (-1) 而不是 undefined,
    // 直接拿去 sendMessage 会抛 "Value must be at least 0", 这里统一当成没有标签页
    const realTabId = (tab?: Browser.tabs.Tab) =>
        tab?.id != null && tab.id >= 0 ? tab.id : undefined;

    // 菜单是否弹在 popup 自己身上: 只看"菜单位于哪个页面", 不看 tab.
    // popup 不是标签页, Chrome 给的是 -1, Firefox 干脆不给 tab, 两边不一致;
    // 而 pageUrl 在两边都是被点击的那个文档的地址
    const popupPageUrl = browser.runtime.getURL('/popup.html');
    const isPopupPage = (url?: string) => !!url && url.split(/[?#]/)[0] === popupPageUrl;

    // 图片扫描: 交给内容脚本取像素并定位蓝框, 注入不了时把图片地址交给 popup 取图解码。
    // 这里必须 await 而不是只挂 .catch: sendMessage 参数非法时是同步抛错, 挂 catch 接不住
    const requestImageScan = async (tabId: number, imageUrl?: string) => {
        try {
            await browser.tabs.sendMessage(tabId, { action: 'scanWebImage', imageUrl });
        } catch {
            // 体验会差一些: 没有扫描动画与蓝框定位, 但能出结果
            await options.sendImageToPopup(imageUrl).catch(() => {});
        }
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
        // 菜单位于 popup 自己身上时, 点哪个扫描项都只是扫它刚生成的那张二维码:
        // popup 不是标签页 (Chrome 给 TAB_ID_NONE, Firefox 不给 tab), 预览图又是 data: 地址,
        // 内容脚本与图片交接都走不通; 而且扫自己没有意义, 所以统一只弹一句彩蛋.
        // 这里不挑菜单项 id: 各家浏览器右键图片时命中的上下文不一定只有 image;
        // pageUrl 也未必给, 再按"没有标签页 + 图片是 data:"兜底 (网页上的 data: 图片有真实标签页)
        const tabId = realTabId(tab);
        if (isPopupPage(info.pageUrl) || (tabId == null && info.srcUrl?.startsWith('data:'))) {
            void browser.runtime.sendMessage({ action: 'scanPopupQr' }).catch(() => {});
            return;
        }

        // 网页图片二维码扫描: 交给内容脚本取像素并定位蓝框, 注入不了时把图片地址交给 popup
        if (info.menuItemId === 'scanWebImage') {
            if (tabId == null) {
                void options.sendImageToPopup(info.srcUrl).catch(() => {});
                return;
            }
            void requestImageScan(tabId, info.srcUrl);
            return;
        }

        // 下面的操作都依赖标签页, 先查询当前前台标签页 ID
        if (tabId == null) {
            // 带上菜单项 id: 各家浏览器命中的上下文不同, 排查时要知道点到的是哪一项
            console.warn('tabId is null', info.menuItemId);
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
