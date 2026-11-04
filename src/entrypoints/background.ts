import { createPopupHost } from '@/services/popupHost';
import { describeImageError } from '@/services/decodeResultNotice';
import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';
import { storageArea } from '@/services/storage';

// WXT 后台脚本入口
export default defineBackground(() => {

    // Firefox 地址栏图标 (page action) 相关变量
    const IS_FIREFOX = import.meta.env.FIREFOX;     // 只有 Firefox 有地址栏图标 (page action) 
    const PAGE_ACTION_KEY = 'pageActionVisible';    // Firefox 地址栏图标显/隐状态持久化储存键
    const isPageActionVisible = async () => {       // Firefox 地址栏图标状态查询函数
        const stored = await browser.storage.local.get(PAGE_ACTION_KEY);
        return stored[PAGE_ACTION_KEY] !== false;   // 只要未明确设置为false, 就取true (默认显示)
    };

    // popup 窗口控制服务
    const popupControl = createPopupHost({
        // 注入 "关闭标签页" 这一后台能力
        closeTab: (tabId) => closeTabAndReturn(tabId),
    });

    // 生成并显示二维码
    const showQRcode = (text?: string) => {
        // 过滤空文本
        const value = text?.trim();
        if (!value) return;

        // 文本储存到本地
        void storageArea().set({ qrCodeText: value });
        // 打开 popup 窗口, 由 popup 生成二维码
        void popupControl.open().catch(() => {});
    };

    // 把图片交给 popup 扫描: 非 HTML 页面 (SVG/PDF) 与截图降级共用同一条交接方式。
    // popup 已打开时会通过 storage.onChanged 自动开始扫描, 无需重复打开。
    const sendImageToPopup = async (imageUrl?: string): Promise<boolean> => {
        if (!imageUrl) return false;
        await storageArea().set({ qrImageUrl: imageUrl });
        if (popupControl.isConnected()) return true;
        await popupControl.open();
        return true;
    };

    const showQrFromImagePage = (imageUrl?: string) => {
        void sendImageToPopup(imageUrl).catch(() => {});
    };

    // 后台发起操作失败时的统一提示 (toast 形态)
    const notifyError = (title: string, text?: string) => popupControl.showNotification({
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
    const showScreenScan = async (
        originTabId?: number,
        windowId?: number,
    ): Promise<boolean> => {
        let dataUrl: string;
        try {
            dataUrl = await captureVisibleArea(windowId);
        } catch (error) {
            await notifyError(
                browser.i18n.getMessage('screenshotFailed'),
                error instanceof Error
                    ? describeImageError(error)
                    : browser.i18n.getMessage('screenshotFailedMsg'),
            );
            return false;
        }
        // 截图体积较大, 交给扩展页面读取后立即清除
        await storageArea().set({ [CAPTURE_IMAGE_KEY]: dataUrl });
        // capture 页只做整图扫描, 不再提供框选
        return openExtensionPage('/capture.html', originTabId);
    };

    // 扫描屏幕: 不做框选, 由内容脚本直接截取视口并扫描整图;
    // 无法注入内容脚本的页面 (如 Firefox 内置 PDF 阅读器) 由后台截取视口后
    // 在新标签页 (capture.html) 直接扫描整图, 与 SVG 页面保持一致。
    // 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用
    const requestScreenScan = async (tabId: number, windowId?: number): Promise<boolean> => {
        if (await tryContentAction(tabId, "scanScreen")) return true;
        return showScreenScan(tabId, windowId);
    };

    // 打开上传图片扫描页 (upload.html): 页面无法注入内容脚本 (PDF、SVG 等) 时才使用
    const openLocalFilePage = (originTabId?: number) =>
        openExtensionPage('/upload.html', originTabId);

    // 摄像头扫码: 只在扩展页面里运行 (popup 失焦即关闭, 内容脚本受页面自身摄像头权限约束),
    // 复用 upload.html 的扫描页, 用 ?camera=1 让页面直接进入摄像头模式
    const openCamerascanScreen = async (originTabId?: number) =>
        openExtensionPage('/upload.html?camera=1', await resolveActiveTabId(originTabId));

    // 上传/粘贴图片: 优先在当前页面弹出扫描浮层, 内容脚本不可用 (如 PDF、SVG) 时
    // 退回独立扫描页, 与扫描屏幕的降级策略保持一致。
    // 工具栏图标的右键菜单不一定会带上 tab 参数, 因此主动查询当前活动标签页。
    const requestLocalImageScan = async (tabId?: number): Promise<boolean> => {
        const targetTabId = await resolveActiveTabId(tabId);
        if (await tryContentAction(targetTabId, "scanLocalImage")) return true;
        return openLocalFilePage(targetTabId);
    };

    // Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
    // 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
    const menuIcons = (name: MenuIconName) => import.meta.env.FIREFOX
        ? { icons: { 16: getMenuIcon(name) } }
        : {};

    // Chrome/Edge 不支持菜单图标, 用 emoji 前缀提升辨识度; Firefox 已有图标, 不重复添加
    type MenuMessageKey = 'scanWebImage' | 'selectionToQR' | 'scanScreen' | 'scanLocalImage' | 'cameraScanTitle';
    const menuTitle = (key: MenuMessageKey, emoji?: string) => {
        const title = browser.i18n.getMessage(key);
        return import.meta.env.FIREFOX || !emoji ? title : `${emoji} ${title}`;
    };

    // 地址栏图标开关只在 Firefox 的工具栏右键菜单里出现, 已有图标故不再拼 emoji
    const pageActionMenuOptions = (visible: boolean) => ({
        title: browser.i18n.getMessage(visible ? 'hidePageAction' : 'showPageAction'),
        ...menuIcons(visible ? 'hide' : 'show'),
    });

    // 初始化右键菜单
    const addContextMenus = async () => {
        const pageActionVisible = IS_FIREFOX && await isPageActionVisible();
        browser.contextMenus.removeAll(() => {
            // 添加菜单: 扫描图中二维码
            browser.contextMenus.create({
                id: "scanWebImage",
                title: menuTitle("scanWebImage", "🔍"),
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
            // 添加菜单: 扫描当前页面
            browser.contextMenus.create({
                id: "scanScreen",
                title: menuTitle("scanScreen", "🖥️"),
                contexts: ["page", "action", "page_action"],
                ...menuIcons("scanScreen")
            });
            // 添加菜单: 扫描本地图片
            browser.contextMenus.create({
                id: "scanLocalImage",
                title: menuTitle("scanLocalImage", "🏞️"),
                contexts: ["action", "page_action"],
                ...menuIcons("image")
            });
            // 添加菜单: 打开摄像头扫描
            browser.contextMenus.create({
                id: "scanCamera",
                title: menuTitle("cameraScanTitle", "📷"),
                contexts: ["action", "page_action"],
                ...menuIcons("camera")
            });
            // Firefox 地址栏图标开关
            if (IS_FIREFOX) {
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
        // 地址栏图标开关
        if (info.menuItemId === "togglePageAction") {
            void togglePageAction();
            return;
        }
        // 选中文字生成二维码
        if (info.menuItemId === "selectionToQR") {
            showQRcode(info.selectionText);
            return;
        }

        // 下面的操作都依赖标签页, 先查询当前前台标签页 ID
        const tabId = tab?.id;   // 获取当前标签页 ID
        if (tabId == null) {
            console.warn('tabId is null');  // tabId 不存在则警告并返回
            return;
        }

        // 扫描本地图片: 弹出图片上传/粘贴窗口
        if (info.menuItemId === "scanLocalImage") {
            // 请求内容脚本弹出扫描面板, 内容脚本不可用时回退到独立扩展页
            void requestLocalImageScan(tabId);
            return;
        }
        // 打开摄像头扫码: 打开以摄像头模式进入的扫描页
        if (info.menuItemId === "scanCamera") {
            void openCamerascanScreen(tabId);
            return;
        }
        // 页面图片二维码扫描, 扫描过程的提示统一由 popup 显示
        if (info.menuItemId === "scanWebImage") {
            // 此URL是包含域名的完整URL, 无论图片是否用了相对路径
            browser.tabs.sendMessage(tabId, {
                action: "scanWebImage",
                imageUrl: info.srcUrl
            }).catch(() => {
                // 如果当前打开的是 PDF、SVG 等无法注入内容脚本的特殊页面
                // 直接把链接传给 popup 打开, 由 popup 完成图片获取和扫描
                showQrFromImagePage(info.srcUrl);
            });
            return;
        }
        // 扫描当前页面: 由内容脚本直接截取视口并扫描整图, 内容脚本不可用时回退到独立扩展页
        if (info.menuItemId === "scanScreen") {
            // SVG 文档同样截取视口后在新标签页直接扫描整图, 避免 popup 窗口裁掉页面内容
            if (isSvgDocumentUrl(tab?.url)) {
                void showScreenScan(tabId, tab?.windowId);
                return;
            }
            void requestScreenScan(tabId, tab?.windowId);
            return;
        }
    };

    // 同步地址栏图标开关菜单项, 使其标题/图标与当前状态一致
    const syncPageActionMenu = async (visible?: boolean) => {
        const current = visible ?? await isPageActionVisible();
        browser.contextMenus.update('togglePageAction', {
            ...pageActionMenuOptions(current),
        }).catch(() => {});
    };

    // 把显隐状态应用到标签页: 单标签的显隐在导航后会重置, 所以既要能全量应用也要能只作用于一个标签页
    const applyPageAction = async (visible: boolean, tabId?: number) => {
        const pageAction = browser.pageAction;
        if (!pageAction) return;
        const tabs = tabId != null ? [{ id: tabId }] : await browser.tabs.query({});
        await Promise.all(tabs.map(async (tab) => {
            if (tab.id == null) return;
            try {
                await (visible ? pageAction.show(tab.id) : pageAction.hide(tab.id));
            } catch {
                // 个别标签页 (如扩展页面) 可能不允许操作, 忽略即可
            }
        }));
    };

    // 切换地址栏图标显隐: 菜单项表达的是"切换", 当前状态查询、取反、持久化与刷新都收敛在这里
    const togglePageAction = async () => {
        if (!IS_FIREFOX) return;
        const visible = !(await isPageActionVisible());
        await browser.storage.local.set({ [PAGE_ACTION_KEY]: visible });
        await applyPageAction(visible);
        void syncPageActionMenu(visible);
    };

    // 显示地址栏图标 (Firefox)
    const showPageAction = async (tabId: number) => {
        if (!IS_FIREFOX || !(await isPageActionVisible())) return;
        await applyPageAction(true, tabId);
    };

    // 内容脚本消息处理
    const handleContentScriptMessage = (request: any, _sender: Browser.runtime.MessageSender, sendResponse: (response: any) => void) => {
        // 全屏扫描的蓝点被点空白处收起前先问一句: 通知窗口是否还开着。
        // 开着说明这一下点击是去关 popup 的, 内容脚本会保留蓝点等下一次点击
        if (request.action === "popupNoticeOpen") {
            sendResponse({ success: true, open: popupControl.isOpen() });
            return false;
        }
        // 页面通知转发到 popup; 独立扫描页会带上 closeOriginTab, 记录发起它的标签页
        if (request.action === "showNotification") {
            popupControl.showNotification(request.payload, _sender.tab?.id)
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // popup 已展示通知, 清理待展示内容 (需要时一并关闭发起它的标签页)
        if (request.action === "notificationResolved") {
            void popupControl.finish(request.id);
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
        // popup 点击"改用扫描屏幕"后, 让当前页面重新截取视口扫描;
        // 纯 SVG 等无法注入内容脚本的页面改为截取视口后在新标签页直接扫描
        if (request.action === "requestScreenScan") {
            browser.tabs.query({ active: true, currentWindow: true })
                .then(async ([tab]) => {
                    if (tab?.id == null) throw new Error('No active tab.');
                    return requestScreenScan(tab.id, tab.windowId);
                })
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // popup 展开面板里的"扫描图片": 与右键菜单共用同一套分发,
        // 优先在当前页开扫描浮层, 内容脚本不可注入时再打开独立扫描页
        if (request.action === "openImageScan") {
            requestLocalImageScan(_sender.tab?.id)
                .then(success => sendResponse({ success }))
                .catch(() => sendResponse({ success: false }));
            return true;
        }
        // 图片扫描浮层里点"从摄像头取图": 摄像头只能在扩展页运行,
        // 由后台打开 upload.html?camera=1, 并记录来源页以便关闭后切回
        if (request.action === "openCameraScan") {
            openCamerascanScreen(_sender.tab?.id)
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

    // popup 打开后建立长连接; 关闭时收起未处理的通知
    browser.runtime.onConnect.addListener(popupControl.connect);

    browser.runtime.onInstalled.addListener(addContextMenus);               // 扩展安装完成时, 初始化右键菜单
    // browser.runtime.onStartup.addListener(addContextMenus);                 // 浏览器启动时, 初始化右键菜单
    // 标签页加载完成后, 显示 Firefox 地址栏图标; 其他浏览器没有该图标, 不必监听
    if (IS_FIREFOX) browser.tabs.onUpdated.addListener((tabId) => void showPageAction(tabId));
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
