// WXT 后台脚本入口
import {
    POPUP_NOTICE_KEY,
    type PopupNoticePayload,
    type PopupNoticeRecord,
} from '@/services/popupNotice';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';
import { storageArea } from '@/services/storage';

export default defineBackground(() => {

    // Firefox 地址栏图标 (page action) 的显/隐状态
    const PAGE_ACTION_VISIBLE_KEY = 'pageActionVisible';
    const isPageActionVisible = async () => {
        const stored = await browser.storage.local.get(PAGE_ACTION_VISIBLE_KEY);
        return stored[PAGE_ACTION_VISIBLE_KEY] !== false;
    };

    // popup 打开状态
    let popupPort: Browser.runtime.Port | null = null;
    // openPopup 会短暂占用弹窗, 期间到达的通知直接等待 popup 读取存储
    let popupOpening = false;
    let lastPopupOpenAt = 0;
    const POPUP_OPEN_GRACE = 1500;

    // 打开 popup 窗口
    // 优先使用 pageAction.openPopup, 不可用或被拒绝时回退 action.openPopup
    const openPopup = async () => {
        // 类型声明里 pageAction 没有 openPopup, 但 Firefox 运行时提供
        const pageAction = browser.pageAction as unknown as { openPopup?: () => Promise<void> } | undefined;
        try {
            if (!pageAction?.openPopup) throw new Error('unavailable');
            await pageAction.openPopup();
        } catch {
            await browser.action.openPopup();
        }
        lastPopupOpenAt = Date.now();
    };

    // 页面通知先写入存储, 保证 popup 打开后能读到; 已打开的 popup 直接通过长连接推送
    let noticeSeq = 0;
    const clearNoticeIfCurrent = async (id: number) => {
        const stored = await storageArea().get(POPUP_NOTICE_KEY);
        const current = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
        if (current?.id === id) await storageArea().remove(POPUP_NOTICE_KEY);
    };

    // 返回 false 表示当前无法显示 popup, 内容脚本将回退到页面内通知
    const showPopupNotification = async (payload?: PopupNoticePayload): Promise<boolean> => {
        if (!payload?.options) return false;

        // 通知总是先落盘, 无论 popup 是否已打开都能读到最新一条
        const record: PopupNoticeRecord = { ...payload, id: ++noticeSeq };
        await storageArea().set({ [POPUP_NOTICE_KEY]: record });

        if (popupPort) {
            try {
                popupPort.postMessage({ action: 'showNotification', payload: record });
                return true;
            } catch {
                popupPort = null;
            }
        }

        // popup 正在打开或刚刚打开: 它挂载后会读取最新通知
        if (popupOpening || Date.now() - lastPopupOpenAt < POPUP_OPEN_GRACE) return true;

        popupOpening = true;
        try {
            await openPopup();
            return true;
        } catch {
            await clearNoticeIfCurrent(record.id);
            return false;
        } finally {
            popupOpening = false;
        }
    };

    // 生成并显示二维码
    const showQRcode = (text?: string) => {
        // 过滤空文本
        const value = text?.trim();
        if (!value) return;

        // 文本储存到本地
        void storageArea().set({ qrCodeText: value });
        // 打开 popup 窗口, 由 popup 生成二维码
        void openPopup().catch(() => {});
    };

    // 把图片交给 popup 识别: 非 HTML 页面 (SVG/PDF) 与截图降级共用同一条交接方式。
    // popup 已打开时会通过 storage.onChanged 自动开始识别, 无需重复打开。
    const sendImageToPopup = async (imageUrl?: string): Promise<boolean> => {
        if (!imageUrl) return false;
        await storageArea().set({ qrImageUrl: imageUrl });
        if (popupPort) return true;
        await openPopup();
        return true;
    };

    const showQrFromImagePage = (imageUrl?: string) => {
        void sendImageToPopup(imageUrl).catch(() => {});
    };

    // 后台发起操作失败时的统一提示 (toast 形态)
    const notifyError = (title: string, text?: string) => showPopupNotification({
        options: { toast: true, icon: 'error', title, text, showCloseButton: true },
    });

    // 打开扩展页面 (capture.html / scan.html) 并统一提示失败
    // WXT 的 getURL 只接受已知入口路径, 这里收紧类型以便拼接查询参数
    type ExtensionPage = `/capture.html${string}` | `/scan.html${string}`;
    const openExtensionPage = async (path: ExtensionPage): Promise<boolean> => {
        try {
            await browser.tabs.create({ url: browser.runtime.getURL(path) });
            return true;
        } catch (error) {
            await notifyError(
                browser.i18n.getMessage('error'),
                error instanceof Error ? error.message : String(error),
            );
            return false;
        }
    };

    // 内容脚本可能未注入 (PDF、SVG 等), 统一处理发送异常与回执
    const tryContentAction = async (tabId: number | undefined, action: string): Promise<boolean> => {
        if (tabId == null) return false;
        try {
            const response = await browser.tabs.sendMessage(tabId, { action }) as { success?: boolean } | undefined;
            return response?.success !== false;
        } catch {
            return false;
        }
    };

    // 工具栏图标右键菜单不一定带 tab 参数, 统一兜底查询当前活动标签页
    const resolveActiveTabId = async (tabId?: number): Promise<number | undefined> => {
        if (tabId != null) return tabId;
        const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
        return activeTab?.id;
    };

    // 直接打开的 SVG 是 XML 文档, 内容脚本无法创建 canvas 和弹窗, 需要交给 popup 处理
    const isSvgDocumentUrl = (url?: string) => {
        if (!url) return false;
        try {
            return new URL(url).pathname.toLowerCase().endsWith('.svg');
        } catch {
            return false;
        }
    };

    // Firefox 浏览器内置 PDF 阅读器页面无法注入内容脚本, 此时截取当前视口,
    // 再在新标签页中框选识别; direct 为 true 时由该页直接识别整图
    const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

    // 截取当前视口 (必须在后台调用, 否则会触发屏幕共享提示并压缩视口)
    const captureVisibleArea = (windowId?: number): Promise<string> =>
        windowId == null
            ? browser.tabs.captureVisibleTab({ format: 'png' })
            : browser.tabs.captureVisibleTab(windowId, { format: 'png' });

    const showCropScan = async (windowId?: number, direct = false): Promise<boolean> => {
        let dataUrl: string;
        try {
            dataUrl = await captureVisibleArea(windowId);
        } catch (error) {
            await notifyError(
                browser.i18n.getMessage('screenshotFailed'),
                error instanceof Error ? error.message : browser.i18n.getMessage('screenshotFailedMsg'),
            );
            return false;
        }
        // 截图体积较大, 交给扩展页面读取后立即清除
        await storageArea().set({ [CAPTURE_IMAGE_KEY]: dataUrl });
        // direct 表示整图直接识别, capture 页不再展示框选界面
        return openExtensionPage(direct ? '/capture.html?direct=1' : '/capture.html');
    };

    // 请求内容脚本开始区域截图; 内容脚本不可用 (如 Firefox 内置 PDF 阅读器) 时才回退到截取视口后框选。
    // 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用。
    const requestAreaScreenshot = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, "screenshotQR")) return true;
        return showCropScan(windowId);
    };

    // 一键截屏识别: 不做交互选区, 由内容脚本直接截取视口并识别整图;
    // 无法注入内容脚本的页面 (如 Firefox 内置 PDF 阅读器) 截取视口后
    // 直接交给 popup 就地识别, 避免为了识别整图再开一个标签页
    const requestQuickScreenshot = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, "screenshotQRDirect")) return true;
        try {
            // 整屏识别不需要交互: 截图后交给 popup 就地识别
            return await sendImageToPopup(await captureVisibleArea(windowId));
        } catch {
            // popup 无法打开时退回新标签页识别
            return showCropScan(windowId, true);
        }
    };

    // 打开独立识别页: 页面无法注入内容脚本 (PDF、SVG 等) 时才使用
    const openScanPage = () => openExtensionPage('/scan.html');

    // 本地/剪贴板图片识别: 优先在当前页面弹出浮层, 内容脚本不可用 (如 PDF、SVG) 时
    // 退回独立识别页, 与截图识别的降级策略保持一致。
    // 工具栏图标的右键菜单不一定会带上 tab 参数, 因此主动查询当前活动标签页。
    const requestInlineImageScan = async (tabId?: number): Promise<boolean> => {
        const targetTabId = await resolveActiveTabId(tabId);
        if (await tryContentAction(targetTabId, "scanImageInline")) return true;
        return openScanPage();
    };

    // Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
    // 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
    const menuIcons = (name: MenuIconName) => import.meta.env.FIREFOX
        ? { icons: { 16: getMenuIcon(name) } }
        : {};

    // Chrome/Edge 不支持菜单图标, 用 emoji 前缀提升辨识度; Firefox 已有图标, 不重复添加
    type MenuMessageKey = 'decodeQR' | 'generateQR_selection'
        | 'screenShot' | 'scanFullScreen' | 'scanImage'
        | 'showPageAction' | 'hidePageAction';
    const menuTitle = (key: MenuMessageKey, emoji?: string) => {
        const title = browser.i18n.getMessage(key);
        return import.meta.env.FIREFOX || !emoji ? title : `${emoji} ${title}`;
    };

    // 右键菜单初始化
    const addContextMenus = async () => {
        const pageActionVisible = await isPageActionVisible();
        browser.contextMenus.removeAll(() => {
            // 添加菜单: 识别图中二维码
            browser.contextMenus.create({
                id: "decodeQR",
                title: menuTitle("decodeQR"),
                contexts: ["image"],
                ...menuIcons("scan")
            });
            // 添加菜单: 选中文字生成二维码
            browser.contextMenus.create({
                id: "generateQR_selection",
                title: menuTitle("generateQR_selection", "📝"),
                contexts: ["selection"],
                ...menuIcons("text")
            });
            // 添加菜单: 整屏识别
            browser.contextMenus.create({
                id: "scanScreen",
                title: menuTitle("scanFullScreen", "🖥️"),
                contexts: ["page", "action", "page_action"],
                ...menuIcons("scanFullScreen")
            });
            // 添加菜单: 框选区域识别
            browser.contextMenus.create({
                id: "screenshotQR",
                title: menuTitle("screenShot", "📷"),
                // 显示在: 网页右键, 扩展图标右键, 地址栏图标右键
                contexts: ["action", "page_action"],
                ...menuIcons("screenshot")
            });
            // 添加菜单: 打开本地图片或剪贴板图片识别
            browser.contextMenus.create({
                id: "scanImage",
                title: menuTitle("scanImage", "📋"),
                contexts: ["action", "page_action"],
                ...menuIcons("image")
            });
            // Firefox 地址栏图标开关: 统一放在工具栏图标右键菜单, 按当前状态显示"显示/隐藏"
            if (browser.pageAction) {
                browser.contextMenus.create({
                    id: "togglePageAction",
                    title: menuTitle(pageActionVisible ? "hidePageAction" : "showPageAction", pageActionVisible ? "🚫" : "👁️"),
                    contexts: ["action"],
                    ...menuIcons(pageActionVisible ? "hide" : "show")
                });
            }
        });
    };

    // 右键菜单点击事件处理
    const handleContextMenusClick = (info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) => {
        // 地址栏图标开关不依赖标签页
        if (info.menuItemId === "togglePageAction") {
            void (async () => {
                await setPageActionVisible(!(await isPageActionVisible()));
            })();
            return;
        }
        // 图片识别优先在当前页面弹出粘贴浮层; 页面无法注入内容脚本时再开新标签页
        if (info.menuItemId === "scanImage") {
            void requestInlineImageScan(tab?.id);
            return;
        }
        const tabId = tab?.id;      // 获取当前标签页 ID
        if (tabId == null) {
            console.warn('tabId is null');  // tabId 不存在则警告并返回
            return;
        } else if (info.menuItemId === "generateQR_selection") {
            // 选中文字生成二维码
            showQRcode(info.selectionText);
        } else if (info.menuItemId === "decodeQR") {
            // 页面图片二维码识别, 识别过程的提示统一由 popup 显示
            // 此URL是包含域名的完整URL, 无论图片是否用了相对路径
            browser.tabs.sendMessage(tabId, {
                action: "decodeQR",
                imageUrl: info.srcUrl
            }).catch(() => {
                // SVG 等无法注入内容脚本的页面: 交给 popup 就地识别图片地址, 不必新开标签
                showQrFromImagePage(info.srcUrl);
            });
        } else if (info.menuItemId === "screenshotQR") {
            // 直接打开的 SVG 文档无法框选截图, 直接解码页面地址
            if (isSvgDocumentUrl(tab?.url)) {
                showQrFromImagePage(info.pageUrl ?? tab?.url);
                return;
            }
            // 截图识别二维码: 优先使用内容脚本的区域截图 (Chrome 的 PDF 页面也能注入);
            // 内容脚本不可用(如 Firefox 内置 PDF 阅读器)时, 改为截取视口后框选识别
            void requestAreaScreenshot(tabId, tab?.windowId);
        } else if (info.menuItemId === "scanScreen") {
            // 一键截屏识别: 直接识别当前视口, 全程没有框选交互
            if (isSvgDocumentUrl(tab?.url)) {
                showQrFromImagePage(info.pageUrl ?? tab?.url);
                return;
            }
            void requestQuickScreenshot(tabId, tab?.windowId);
        }
    };

    // 同步地址栏图标开关菜单项, 使其标题/图标与当前状态一致
    const syncPageActionMenu = async (visible?: boolean) => {
        const current = visible ?? await isPageActionVisible();
        browser.contextMenus.update('togglePageAction', {
            title: menuTitle(current ? 'hidePageAction' : 'showPageAction', current ? '🚫' : '👁️'),
            ...menuIcons(current ? 'hide' : 'show'),
        }).catch(() => {});
    };

    // 显示/隐藏地址栏图标 (Firefox), 并记住状态
    const setPageActionVisible = async (visible: boolean) => {
        await browser.storage.local.set({ [PAGE_ACTION_VISIBLE_KEY]: visible });
        const pageAction = browser.pageAction;
        if (pageAction) {
            const tabs = await browser.tabs.query({});
            await Promise.all(tabs.map(async (tab) => {
                if (tab.id == null) return;
                try {
                    await (visible ? pageAction.show(tab.id) : pageAction.hide(tab.id));
                } catch {
                    // 个别标签页 (如扩展页面) 可能不允许操作, 忽略即可
                }
            }));
        }
        void syncPageActionMenu(visible);
    };

    // 显示地址栏图标 (Firefox)
    const showPageAction = async (tabId?: number) => {
        const pageAction = browser.pageAction;
        if (!pageAction) return;
        try {
            if (!(await isPageActionVisible())) return;
            const tabs = tabId != null ? [{ id: tabId }] : await browser.tabs.query({});
            for (const tab of tabs) {
                if (tab.id == null) continue;
                try {
                    // show() 在部分类型定义中返回 void, 运行时则可能是 Promise
                    void Promise.resolve(pageAction.show(tab.id)).catch(() => {});
                } catch {
                    // 忽略受限标签页导致的失败
                }
            }
        } catch {
            // 忽略受限标签页导致的失败
        }
    };

    // 内容脚本消息处理
    const handleContentScriptMessage = (request: any, _sender: Browser.runtime.MessageSender, sendResponse: (response: any) => void) => {
        // 页面通知转发到 popup
        if (request.action === "showNotification") {
            showPopupNotification(request.payload)
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // popup 已展示通知, 清理待展示内容
        if (request.action === "notificationResolved") {
            void clearNoticeIfCurrent(request.id);
            sendResponse({ success: true });
            return false;
        }
        // 截取当前标签页可见区域: 由后台调用可避免 getDisplayMedia 的屏幕共享提示条压缩页面视口
        if (request.action === "captureVisibleTab") {
            // 消息可能来自内容脚本(sender.tab), 也可能来自 popup(无 sender.tab)
            const resolveWindowId = async () => {
                if (_sender.tab?.windowId != null) return _sender.tab.windowId;
                const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
                return tab?.windowId;
            };
            resolveWindowId()
                .then(windowId =>
                    windowId == null
                        ? browser.tabs.captureVisibleTab({ format: "png" })
                        : browser.tabs.captureVisibleTab(windowId, { format: "png" }))
                .then(dataUrl => sendResponse({ success: true, dataUrl }))
                .catch(error => sendResponse({ success: false, error: error?.message ?? String(error) }));
            return true;
        }
        // popup 点击"改用截图识别"后, 让当前页面的内容脚本开始区域截图;
        // 纯 SVG 等无法注入内容脚本的页面改为截取视口后在新标签页框选识别
        if (request.action === "requestScreenshot") {
            browser.tabs.query({ active: true, currentWindow: true })
                .then(async ([tab]) => {
                    if (tab?.id == null) throw new Error('No active tab.');
                    return requestAreaScreenshot(tab.id, tab.windowId);
                })
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // 跨域获取图片数据
        if (request.action === "fetchImage") {
            fetch(request.url)                       // 请求图片资源
                .then(response => response.blob())   // 获取图片的 Blob 数据
                .then(blob => {
                    const reader = new FileReader();    // 使用 FileReader 将 Blob 转为 Data URL
                    reader.onload = () => sendResponse({ success: true, dataUrl: reader.result }); // 读取完成后发送回 Data URL
                    reader.readAsDataURL(blob);      // 开始读取 Blob 数据
                })
                .catch(error => sendResponse({ success: false, error: error.message })); // 出错时发送错误信息
        }
        return true; // 保持通道开启
        // 防止 Error: The message port closed before a response was received.
    };

    // 事件监听
    browser.runtime.onConnect.addListener((port) => {
        if (port.name !== 'popup') return;
        popupPort = port;
        // 补推挂载期间写入的通知, 避免 openPopup 与端口连接之间的竞态导致通知丢失
        void storageArea().get(POPUP_NOTICE_KEY).then((stored) => {
            const record = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
            if (record && popupPort === port) port.postMessage({ action: 'showNotification', payload: record });
        }).catch(() => {});
        port.onDisconnect.addListener(() => {
            if (popupPort === port) popupPort = null;
            lastPopupOpenAt = 0;
            // popup 关闭后清除未处理的通知, 避免下次打开时旧通知再次出现
            void storageArea().remove(POPUP_NOTICE_KEY).catch(() => {});
        });
    });

    browser.runtime.onInstalled.addListener(addContextMenus);               // 扩展安装完成时, 初始化右键菜单
    // browser.runtime.onStartup.addListener(addContextMenus);                 // 浏览器启动时, 初始化右键菜单
    browser.tabs.onUpdated.addListener((tabId) => void showPageAction(tabId)); // 标签页加载完成后, 显示地址栏图标
    browser.contextMenus.onClicked.addListener(handleContextMenusClick);    // 右键菜单点击事件处理
    browser.runtime.onMessage.addListener(handleContentScriptMessage);      // 处理内容脚本的请求
});
