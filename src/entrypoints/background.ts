import { createContextMenus } from '@/services/background/contextMenus';
import { createExtensionTabs } from '@/services/background/extensionTabs';
import { createBackgroundMessageHandler } from '@/services/background/messages';
import { createPageAction } from '@/services/background/pageAction';
import { createScanEntry } from '@/services/background/scanEntry';
import { createScreenScan } from '@/services/background/screenScan';
import { createPopupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';

// WXT 后台脚本入口
// 后台脚本是一个浏览器插件的主进程, 是插件各组件之间的通信中心
export default defineBackground(() => {

    // popup 窗口控制器
    const popupControl = createPopupHost({
        // 注入 "关闭标签页" 这一后台能力, 独立扫描页的通知结束后由 popup 触发
        closeTab: (tabId) => extensionTabs.closeAndReturn(tabId),
    });

    const extensionTabs = createExtensionTabs();
    const scanEntry = createScanEntry({
        popup: popupControl,
        openExtensionPage: extensionTabs.open,
    });

    // 屏幕截图扫描
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
        showQrFromImagePage: scanEntry.showQrFromImagePage,
        requestScreenScan: screenScan.request,
        showScreenScan: screenScan.show,
        requestLocalImageScan: scanEntry.requestLocalImageScan,
        openCameraScan: scanEntry.openCameraScan,
    });


    // popup 打开后建立长连接; 关闭时收起未处理的通知
    browser.runtime.onConnect.addListener(popupControl.connect);
    // 扩展安装/升级时重建右键菜单 (菜单不能跨版本沿用)
    browser.runtime.onInstalled.addListener(() => void menus.add());
    // 标签页加载完成后恢复 Firefox 地址栏图标, 其他浏览器没有该图标, 不必监听
    if (import.meta.env.FIREFOX) browser.tabs.onUpdated.addListener((tabId) => void pageAction.show(tabId));
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
