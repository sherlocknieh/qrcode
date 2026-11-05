import { createContextMenus } from '@/services/background/contextMenus';
import { createExtensionTabs } from '@/services/background/extensionTabs';
import { createBackgroundMessageHandler } from '@/services/background/messages';
import { createPageAction } from '@/services/background/pageAction';
import { createScanEntry } from '@/services/background/scanEntry';
import { createScreenScan } from '@/services/background/screenScan';
import { createPopupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';


// WXT 后台脚本入口：浏览器插件的主进程, 各组件(如 popup、扩展页、内容脚本等)之间互相通信的中心
export default defineBackground(() => {

    // 扩展标签页管理器
    const extensionTabs = createExtensionTabs();

    // popup窗口管理器
    const popupControl = createPopupHost({
        // 注入 "关闭标签页" 这一后台能力, 独立扫描页的通知结束后由 popup 触发
        closeTab: (tabId) => extensionTabs.closeAndReturn(tabId),
    });

    // 扫描入口: 由内容脚本、右键菜单、扩展页等触发, 统一调度扫描流程
    const scanEntry = createScanEntry({
        popup: popupControl,
        openExtensionPage: extensionTabs.open,
    });

    // 屏幕截图扫描器
    const screenScan = createScreenScan({
        openExtensionPage: extensionTabs.open,
        tryContentAction: scanEntry.tryContentAction,
    });
    const pageAction = createPageAction();

    // 生成并显示二维码: 文本落盘后由 popup 渲染, 空文本直接忽略
    const showQRcode = (text?: string) => {
        const value = text?.trim();
        if (!value) return;
        void storageArea().set({ qrCodeText: value });
        void popupControl.open().catch(() => {});
    };

    // 右键菜单
    const menus = createContextMenus({
        pageAction,
        showQRcode,
        sendImageToPopup: scanEntry.sendImageToPopup,
        requestScreenScan: screenScan.request,
        showScreenScan: screenScan.show,
        requestLocalImageScan: scanEntry.requestLocalImageScan,
        openCameraScan: scanEntry.openCameraScan,
    });


    // 在本扩展中 popup 打开时会发起建立长连接; 监听并处理连接事件
    browser.runtime.onConnect.addListener(popupControl.connect);

    // 扩展安装/升级时重建右键菜单 (菜单不能跨版本沿用)
    browser.runtime.onInstalled.addListener(() => void menus.add());

    // 标签页加载完成时添加 Firefox 地址栏图标
    if (import.meta.env.FIREFOX)
        browser.tabs.onUpdated.addListener((tabId) => void pageAction.show(tabId));

    // 用户手动点 X 关闭临时扩展页 (capture / upload) 时把焦点还给来源页;
    // 由后台主动关闭的标签页已先清除记录, 不会重复处理
    browser.tabs.onRemoved.addListener((tabId) => void extensionTabs.returnToOrigin(tabId));

    // 监听并处理右键菜单点击事件
    browser.contextMenus.onClicked.addListener(menus.handleClick);

    // 监听并处理来自内容脚本、扩展页、popup 的消息
    browser.runtime.onMessage.addListener(createBackgroundMessageHandler({
        popup: popupControl,
        tabs: extensionTabs,
        scanEntry,
        screenScan,
    }));
});
