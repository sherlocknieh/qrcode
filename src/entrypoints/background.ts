import { addContextMenus, handleContextMenuClick } from '@/services/background/contextMenus';
import { returnToOrigin } from '@/services/background/extensionTabs';
import { handleBackgroundMessage } from '@/services/background/messages';
import { addPageActionMenuItem, handlePageActionClick, showPageAction } from '@/services/background/pageAction';
import { popupHost } from '@/services/popupHost';

// WXT 后台脚本入口：
// 浏览器插件的主进程
// 各组件(如 popup、扩展页、内容脚本等)之间互相通信的中心。
// 这里只注册事件, 各事件的处理都在 services/background/ 下对应的模块里
export default defineBackground(() => {
    // 在本扩展中 popup 打开时会发起建立长连接; 监听并处理连接事件
    browser.runtime.onConnect.addListener(popupHost.connect);

    // 扩展安装/升级时重建右键菜单 (菜单不能跨版本沿用).
    // 地址栏开关挂在同一份菜单上, 必须在菜单重建完成后再加, 否则会被 removeAll 清掉
    browser.runtime.onInstalled.addListener(() => {
        void addContextMenus().then(addPageActionMenuItem);
    });

    // 标签页加载完成时添加 Firefox 地址栏图标
    if (import.meta.env.FIREFOX)
        browser.tabs.onUpdated.addListener((tabId) => void showPageAction(tabId));

    // 用户手动点 X 关闭临时扩展页 (capture / upload) 时把焦点还给来源页;
    // 由后台主动关闭的标签页已先清除记录, 不会重复处理
    browser.tabs.onRemoved.addListener((tabId) => void returnToOrigin(tabId));

    // 监听并处理右键菜单点击事件: 地址栏开关归 pageAction 自己管, 其余交给菜单模块
    browser.contextMenus.onClicked.addListener((info, tab) => {
        if (handlePageActionClick(info.menuItemId)) return;
        void handleContextMenuClick(info, tab);
    });

    // 监听并处理来自内容脚本、扩展页、popup 的消息
    browser.runtime.onMessage.addListener(handleBackgroundMessage);
});
