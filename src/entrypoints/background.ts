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

    // 通知结束 (popup 展示完毕或 popup 被关闭) 后清理记录;
    // 独立扫描页 (capture.html) 发起的通知会把该标签页一并关闭, 并切回来源页面
    const finishNotice = async (id?: number) => {
        const stored = await storageArea().get(POPUP_NOTICE_KEY);
        const current = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
        if (!current) return;
        if (id != null && current.id !== id) return;
        await storageArea().remove(POPUP_NOTICE_KEY);
        if (current.closeTabId != null) {
            await closeTabAndReturn(current.closeTabId);
        }
    };

    // 返回 false 表示当前无法显示 popup, 内容脚本将回退到页面内通知
    const showPopupNotification = async (
        payload?: PopupNoticePayload,
        sourceTabId?: number,
    ): Promise<boolean> => {
        if (!payload?.options) return false;

        // 通知总是先落盘, 无论 popup 是否已打开都能读到最新一条
        const record: PopupNoticeRecord = {
            ...payload,
            id: ++noticeSeq,
            closeTabId: payload.closeOriginTab ? sourceTabId : undefined,
        };
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

    // 把图片交给 popup 扫描: 非 HTML 页面 (SVG/PDF) 与截图降级共用同一条交接方式。
    // popup 已打开时会通过 storage.onChanged 自动开始扫描, 无需重复打开。
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

    // 打开扩展页面 (capture.html / upload.html) 并统一提示失败。
    // originTabId 是发起操作的页面: 新标签紧挨着它打开, 关闭后也回到它, 而不是相邻标签页。
    // WXT 的 getURL 只接受已知入口路径, 这里收紧类型以便拼接查询参数
    type ExtensionPage = `/capture.html${string}` | `/upload.html${string}`;

    // 取来源页的窗口与位置: 传了 index 才会紧挨源页, 否则 tabs.create 会追加到标签栏末尾
    const resolveOriginPlacement = async (
        originTabId?: number,
    ): Promise<{ windowId?: number; index?: number }> => {
        if (originTabId == null) return {};
        try {
            const tab = await browser.tabs.get(originTabId);
            return typeof tab?.index === 'number'
                ? { windowId: tab.windowId, index: tab.index + 1 }
                : {};
        } catch {
            return {};
        }
    };

    const openExtensionPage = async (path: ExtensionPage, originTabId?: number): Promise<boolean> => {
        try {
            const placement = await resolveOriginPlacement(originTabId);
            const tab = await browser.tabs.create({ url: browser.runtime.getURL(path), ...placement });
            if (tab?.id != null) await rememberOriginTab(tab.id, originTabId);
            return true;
        } catch (error) {
            await notifyError(
                browser.i18n.getMessage('error'),
                error instanceof Error ? error.message : String(error),
            );
            return false;
        }
    };

    // 临时扩展页 (capture / scan) 关闭后要回到的页面。
    // tabs.remove 只会切到相邻标签, 需要记录来源页并手动切回去
    const ORIGIN_TABS_KEY = 'qrExtensionOriginTabs';

    // 按扩展页标签 id 记录来源页, 允许同时存在多个临时标签页
    const rememberOriginTab = async (extensionTabId: number, originTabId?: number) => {
        if (originTabId == null) return;
        const stored = await storageArea().get(ORIGIN_TABS_KEY);
        const map = { ...(stored?.[ORIGIN_TABS_KEY] as Record<string, number> | undefined) };
        map[String(extensionTabId)] = originTabId;
        await storageArea().set({ [ORIGIN_TABS_KEY]: map }).catch(() => {});
    };

    // 取出并清除某个扩展页记录的来源页
    const takeOriginTab = async (extensionTabId: number): Promise<number | undefined> => {
        const stored = await storageArea().get(ORIGIN_TABS_KEY);
        const map = { ...(stored?.[ORIGIN_TABS_KEY] as Record<string, number> | undefined) };
        const originTabId = map[String(extensionTabId)];
        delete map[String(extensionTabId)];
        if (Object.keys(map).length) {
            await storageArea().set({ [ORIGIN_TABS_KEY]: map }).catch(() => {});
        } else {
            await storageArea().remove(ORIGIN_TABS_KEY).catch(() => {});
        }
        return typeof originTabId === 'number' ? originTabId : undefined;
    };

    // 关闭临时标签页并把焦点还给打开它的页面
    const closeTabAndReturn = async (closingTabId: number) => {
        const originTabId = await takeOriginTab(closingTabId);
        if (originTabId != null && originTabId !== closingTabId) {
            // 先激活来源页再关闭, 否则浏览器会自己挑一个相邻标签
            await browser.tabs.update(originTabId, { active: true }).catch(() => {});
        }
        await browser.tabs.remove(closingTabId).catch(() => {});
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

    // 直接打开的 SVG 是 XML 文档, 内容脚本不会注入, 截图类操作需要截取视口后走扩展页面。
    // 兜底交给 popup 会受其窗口尺寸限制, 因此截图与整屏扫描统一在新标签页完成。
    const isSvgDocumentUrl = (url?: string) => {
        if (!url) return false;
        try {
            return new URL(url).pathname.toLowerCase().endsWith('.svg');
        } catch {
            return false;
        }
    };

    // Firefox 浏览器内置 PDF 阅读器页面无法注入内容脚本, 此时截取当前视口,
    // 再在新标签页中框选扫描; direct 为 true 时由该页直接扫描整图
    const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

    // 截取当前视口 (必须在后台调用, 否则会触发屏幕共享提示并压缩视口)
    const captureVisibleArea = (windowId?: number): Promise<string> =>
        windowId == null
            ? browser.tabs.captureVisibleTab({ format: 'png' })
            : browser.tabs.captureVisibleTab(windowId, { format: 'png' });

    // originTabId 用于关闭 capture 页时切回来源页面, 否则浏览器会切到相邻标签
    const showCropScan = async (
        originTabId?: number,
        windowId?: number,
        direct = false,
    ): Promise<boolean> => {
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
        // direct 表示整图直接扫描, capture 页不再展示框选界面
        return openExtensionPage(direct ? '/capture.html?direct=1' : '/capture.html', originTabId);
    };

    // 请求内容脚本开始区域截图; 内容脚本不可用 (如 Firefox 内置 PDF 阅读器) 时才回退到截取视口后框选。
    // 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用。
    const requestAreaScreenshot = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, "screenshotQR")) return true;
        return showCropScan(tabId, windowId);
    };

    // 一键截屏扫描: 不做交互选区, 由内容脚本直接截取视口并扫描整图;
    // 无法注入内容脚本的页面 (如 Firefox 内置 PDF 阅读器) 由后台截取视口后
    // 在新标签页 (capture.html?direct=1) 直接扫描整图, 与 SVG 页面保持一致
    const requestQuickScreenshot = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, "scanFullScreen")) return true;
        return showCropScan(tabId, windowId, true);
    };

    // 打开上传图片扫描页 (upload.html): 页面无法注入内容脚本 (PDF、SVG 等) 时才使用
    const openLocalFilePage = (originTabId?: number) =>
        openExtensionPage('/upload.html', originTabId);

    // 摄像头扫码: 只在扩展页面里运行 (popup 失焦即关闭, 内容脚本受页面自身摄像头权限约束),
    // 复用 upload.html 的扫描页, 用 ?camera=1 让页面直接进入摄像头模式
    const openCameraScanPage = async (originTabId?: number) =>
        openExtensionPage('/upload.html?camera=1', await resolveActiveTabId(originTabId));

    // 上传/粘贴图片: 优先在当前页面弹出扫描浮层, 内容脚本不可用 (如 PDF、SVG) 时
    // 退回独立扫描页, 与截图扫描的降级策略保持一致。
    // 工具栏图标的右键菜单不一定会带上 tab 参数, 因此主动查询当前活动标签页。
    const requestInlineImageScan = async (tabId?: number): Promise<boolean> => {
        const targetTabId = await resolveActiveTabId(tabId);
        if (await tryContentAction(targetTabId, "scanImageInline")) return true;
        return openLocalFilePage(targetTabId);
    };

    // Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
    // 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
    const menuIcons = (name: MenuIconName) => import.meta.env.FIREFOX
        ? { icons: { 16: getMenuIcon(name) } }
        : {};

    // Chrome/Edge 不支持菜单图标, 用 emoji 前缀提升辨识度; Firefox 已有图标, 不重复添加
    type MenuMessageKey = 'decodeQR' | 'selectionToQR'
        | 'screenShot' | 'scanFullScreen' | 'scanImage' | 'cameraScanTitle'
        | 'showPageAction' | 'hidePageAction';
    const menuTitle = (key: MenuMessageKey, emoji?: string) => {
        const title = browser.i18n.getMessage(key);
        return import.meta.env.FIREFOX || !emoji ? title : `${emoji} ${title}`;
    };

    const pageActionMenuOptions = (visible: boolean) => ({
        title: menuTitle(visible ? "hidePageAction" : "showPageAction", visible ? "🚫" : "👁️"),
        ...menuIcons(visible ? "hide" : "show"),
    });

    // 右键菜单初始化
    const addContextMenus = async () => {
        const pageActionVisible = await isPageActionVisible();
        browser.contextMenus.removeAll(() => {
            // 添加菜单: 扫描图中二维码
            browser.contextMenus.create({
                id: "decodeQR",
                title: menuTitle("decodeQR", "🔍"),
                contexts: ["image"],
                ...menuIcons("scan")
            });
            // 添加菜单: 选中文字生成二维码
            browser.contextMenus.create({
                id: "selectionToQR",
                title: menuTitle("selectionToQR", "📝"),
                contexts: ["selection"],
                ...menuIcons("text")
            });
            // 添加菜单: 整屏扫描
            browser.contextMenus.create({
                id: "scanFullScreen",
                title: menuTitle("scanFullScreen", "🖥️"),
                contexts: ["page", "action", "page_action"],
                ...menuIcons("scanFullScreen")
            });
            // 添加菜单: 框选区域扫描
            browser.contextMenus.create({
                id: "screenshotQR",
                title: menuTitle("screenShot", "🔲"),
                // 显示在: 网页右键, 扩展图标右键, 地址栏图标右键
                contexts: ["action", "page_action"],
                ...menuIcons("screenshot")
            });
            // 添加菜单: 摄像头扫码, 直接以摄像头模式打开扫描页
            browser.contextMenus.create({
                id: "scanCamera",
                title: menuTitle("cameraScanTitle", "📷"),
                contexts: ["action", "page_action"],
                ...menuIcons("camera")
            });
            // 添加菜单: 上传/粘贴图片扫描
            browser.contextMenus.create({
                id: "scanImage",
                title: menuTitle("scanImage", "🏞️"),
                contexts: ["action", "page_action"],
                ...menuIcons("image")
            });
            // Firefox 地址栏图标开关: 统一放在工具栏图标右键菜单, 按当前状态显示"显示/隐藏"
            if (browser.pageAction) {
                browser.contextMenus.create({
                    id: "togglePageAction",
                    ...pageActionMenuOptions(pageActionVisible),
                    contexts: ["action"],
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
        // 上传/粘贴图片: 在当前页弹出扫描浮层
        if (info.menuItemId === "scanImage") {
            void requestInlineImageScan(tab?.id);
            return;
        }
        // 摄像头扫码: 打开以摄像头模式进入的扫描页
        if (info.menuItemId === "scanCamera") {
            void openCameraScanPage(tab?.id);
            return;
        }
        const tabId = tab?.id;      // 获取当前标签页 ID
        if (tabId == null) {
            console.warn('tabId is null');  // tabId 不存在则警告并返回
            return;
        } else if (info.menuItemId === "selectionToQR") {
            // 选中文字生成二维码
            showQRcode(info.selectionText);
        } else if (info.menuItemId === "decodeQR") {
            // 页面图片二维码扫描, 扫描过程的提示统一由 popup 显示
            // 此URL是包含域名的完整URL, 无论图片是否用了相对路径
            browser.tabs.sendMessage(tabId, {
                action: "decodeQR",
                imageUrl: info.srcUrl
            }).catch(() => {
                // SVG 等无法注入内容脚本的页面: 交给 popup 就地扫描图片地址, 不必新开标签
                showQrFromImagePage(info.srcUrl);
            });
        } else if (info.menuItemId === "screenshotQR") {
            // 截图扫描二维码: 优先使用内容脚本的区域截图 (Chrome 的 PDF 页面也能注入);
            // 内容脚本不可用 (如 Firefox 内置 PDF 阅读器、SVG 文档) 时,
            // 改为截取视口后在新标签页中框选扫描, 不在 popup 里就地处理
            if (isSvgDocumentUrl(tab?.url)) {
                void showCropScan(tabId, tab?.windowId);
                return;
            }
            void requestAreaScreenshot(tabId, tab?.windowId);
        } else if (info.menuItemId === "scanFullScreen") {
            // 一键截屏扫描: 直接扫描当前视口, 全程没有框选交互
            // SVG 文档同样截取视口后在新标签页直接扫描整图, 避免 popup 窗口裁掉页面内容
            if (isSvgDocumentUrl(tab?.url)) {
                void showCropScan(tabId, tab?.windowId, true);
                return;
            }
            void requestQuickScreenshot(tabId, tab?.windowId);
        }
    };

    // 同步地址栏图标开关菜单项, 使其标题/图标与当前状态一致
    const syncPageActionMenu = async (visible?: boolean) => {
        const current = visible ?? await isPageActionVisible();
        browser.contextMenus.update('togglePageAction', {
            ...pageActionMenuOptions(current),
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
        // 页面通知转发到 popup; 独立扫描页会带上 closeOriginTab, 记录发起它的标签页
        if (request.action === "showNotification") {
            showPopupNotification(request.payload, _sender.tab?.id)
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // popup 已展示通知, 清理待展示内容 (需要时一并关闭发起它的标签页)
        if (request.action === "notificationResolved") {
            void finishNotice(request.id);
            sendResponse({ success: true });
            return false;
        }
        // 临时扩展页请求关闭自己 (框选取消 / 页面内通知结束), 由后台切回来源页再关闭
        if (request.action === "closeExtensionTab") {
            const tabId = _sender.tab?.id;
            if (tabId == null) {
                sendResponse({ success: false });
                return false;
            }
            closeTabAndReturn(tabId)
                .then(() => sendResponse({ success: true }))
                .catch(() => sendResponse({ success: false }));
            return true;
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
        // popup 点击"改用截图扫描"后, 让当前页面的内容脚本开始区域截图;
        // 纯 SVG 等无法注入内容脚本的页面改为截取视口后在新标签页框选扫描
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
        // 图片扫描浮层里点"从摄像头取图": 摄像头只能在扩展页运行,
        // 由后台打开 upload.html?camera=1, 并记录来源页以便关闭后切回
        if (request.action === "openCameraScan") {
            openCameraScanPage(_sender.tab?.id)
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
            // popup 关闭后清除未处理的通知, 避免下次打开时旧通知再次出现;
            // 通知来自独立扫描页时同时关闭该标签页 (用户关掉通知即视为结束)
            void finishNotice().catch(() => {});
        });
    });

    browser.runtime.onInstalled.addListener(addContextMenus);               // 扩展安装完成时, 初始化右键菜单
    // browser.runtime.onStartup.addListener(addContextMenus);                 // 浏览器启动时, 初始化右键菜单
    browser.tabs.onUpdated.addListener((tabId) => void showPageAction(tabId)); // 标签页加载完成后, 显示地址栏图标
    // 用户手动关闭临时扩展页 (capture / scan) 时, 同样把焦点还给来源页;
    // 由后台主动关闭的标签页已先清除记录, 不会重复处理
    browser.tabs.onRemoved.addListener((tabId) => {
        void takeOriginTab(tabId).then(async (originTabId) => {
            if (originTabId == null) return;
            await browser.tabs.update(originTabId, { active: true }).catch(() => {});
        });
    });
    browser.contextMenus.onClicked.addListener(handleContextMenusClick);    // 右键菜单点击事件处理
    browser.runtime.onMessage.addListener(handleContentScriptMessage);      // 处理内容脚本的请求
});
