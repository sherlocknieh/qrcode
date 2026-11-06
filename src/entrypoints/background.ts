import { connectExtensionPage, returnToOrigin } from '@/services/background/extensionTabs';
import { handleBackgroundMessage } from '@/services/background/messages';
import { addPageActionMenuItem, handlePageActionClick, showPageAction } from '@/services/background/pageAction';
import { openLocalScanPanel, requestWebImageScan } from '@/services/background/scanEntry';
import { requestFrameScan, requestScreenScan } from '@/services/background/screenScan';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';
import { popupHost } from '@/services/popupHost';


// 设置右键菜单图标
const IS_FIREFOX = import.meta.env.FIREFOX;
// Firefox 内置支持图标设置
const setMenuIcon = (name: MenuIconName) => IS_FIREFOX ? { icons: { 16: getMenuIcon(name) } } : {};
// Chrome 只能通过在标题前添加 emoji 来充当图标
type MenuMessageKey = 'selectionToQR' | 'scanWebImage' | 'scanScreen' | 'scanRegion' | 'scanCamera';
const setMenuTitle = (key: MenuMessageKey, emoji?: string) => {
    const title = browser.i18n.getMessage(key);
    return IS_FIREFOX || !emoji ? title : `${emoji} ${title}`;
};

// 初始化右键菜单
const addContextMenus = () => new Promise<void>((resolve) => {
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
            contexts: ['page', 'action', 'page_action'],
            ...setMenuIcon('scanScreen'),
        });
        // 框选页面上特定区域扫描
        browser.contextMenus.create({
            id: 'scanRegion',
            title: setMenuTitle('scanRegion', '🔲'),
            contexts: ['action', 'page_action'],
            ...setMenuIcon('scanRegion'),
        });
        // 外部来源扫描: 相机/本地图片扫描
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
const handleContextMenuClick = (
    info: Browser.contextMenus.OnClickData,
    tab?: Browser.tabs.Tab) => {

    // 选中文字生成二维码
    if (info.menuItemId === 'selectionToQR') {
        void popupHost.showQrCode(info.selectionText).catch(() => { });
        return;
    }

    // 扫描网页图片中的二维码
    if (info.menuItemId === 'scanWebImage') {
        void requestWebImageScan(tab?.id, info.srcUrl, info.pageUrl);
        return;
    }

    // 打开扫码面板: 相机与上传图片在面板内切换
    if (info.menuItemId === 'scanCamera') {
        void openLocalScanPanel(tab?.id);
        return;
    }

    // 扫描当前页面视口: 独立 SVG 由 requestScreenScan 内部跳过内容脚本
    if (info.menuItemId === 'scanScreen') {
        void requestScreenScan(tab?.id, tab?.windowId, tab?.url);
    }
    // 框选扫描: 注入不了内容脚本的页面由 requestFrameScan 自己退到可框选的截图页
    if (info.menuItemId === 'scanRegion') {
        void requestFrameScan(tab?.id);
    }
};

// WXT 后台脚本入口
export default defineBackground(() => {
    
    // 监听 popup 发起的连接事件: 用于探测 popup 的打开
    browser.runtime.onConnect.addListener(popupHost.connect);
    // 临时扩展页 (capture) 自己连上来: tabs.sendMessage 投递不到扩展页,
    // 通知里的"框选扫描"要落回持有截图的那一页, 只能走这条端口
    browser.runtime.onConnect.addListener(connectExtensionPage);

    // 扩展安装/升级时重建右键菜单 (菜单不能跨版本沿用).
    // 地址栏开关挂在同一份菜单上, 必须在菜单重建完成后再加, 否则会被 removeAll 清掉
    browser.runtime.onInstalled.addListener(() => {
        void addContextMenus().then(addPageActionMenuItem);
    });

    // 标签页加载完成时添加 Firefox 地址栏图标
    if (IS_FIREFOX)
        browser.tabs.onUpdated.addListener((tabId) => void showPageAction(tabId));

    // 用户手动点 X 关闭临时扩展页 (capture / upload) 时把焦点还给来源页;
    // 由后台主动关闭的标签页已先清除记录, 不会重复处理
    browser.tabs.onRemoved.addListener((tabId) => void returnToOrigin(tabId));

    // 监听并处理右键菜单点击事件: 地址栏开关归 pageAction 自己管, 其余按菜单项 id 分发
    browser.contextMenus.onClicked.addListener((info, tab) => {
        if (handlePageActionClick(info.menuItemId)) return;
        handleContextMenuClick(info, tab);
    });

    // 监听并处理来自内容脚本、扩展页、popup 的消息
    browser.runtime.onMessage.addListener(handleBackgroundMessage);
});
