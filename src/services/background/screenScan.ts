import { openExtensionPage, sendExtensionPageAction, type ExtensionPage } from '@/services/background/extensionTabs';
import { resolveActiveTabId, sendTabAction } from '@/services/messaging';
import { popupHost } from '@/services/popupHost';
import { storageArea } from '@/services/storage';

// 后台截取的视口图, 由 capture.html 读取后立即删除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// 直接打开的 SVG 是 XML 文档, 内容脚本不会注入, 要跳过内容脚本直接截视口
const isSvgDocumentUrl = (url?: string) => {
    if (!url) return false;
    try {
        return new URL(url).pathname.toLowerCase().endsWith('.svg');
    } catch {
        return false;
    }
};

// 截取当前视口: 必须在后台调用, 否则会触发屏幕共享提示并压缩视口
export const captureVisibleTab = (windowId?: number): Promise<string> => windowId == null
    ? browser.tabs.captureVisibleTab({ format: 'png' })
    : browser.tabs.captureVisibleTab(windowId, { format: 'png' });

// 预热的视口图只能用这么久的画面: 过期了宁可现截一张, 也不能拿旧画面冒充当前屏幕
const PRIMED_CAPTURE_TTL_MS = 5000;

type PrimedCapture = { tabId: number; dataUrl: string; at: number };

// 预热的视口图: 右键菜单弹出、popup 抽屉展开时就截好, 点扫描时直接复用。
// 整屏 PNG 编码是"点下去到截图出现"里最贵的一段, 提到用户做决定之前就做完了
let primedCapture: PrimedCapture | undefined;
// 预热还在路上: 扫描请求碰上它就直接等这一张, 同一画面不截两遍
let priming: Promise<void> | undefined;

const isFreshFor = (capture: PrimedCapture | undefined, tabId?: number): capture is PrimedCapture =>
    capture != null
    && capture.tabId === tabId
    && Date.now() - capture.at < PRIMED_CAPTURE_TTL_MS;

// 预热一张视口图供紧接着的扫描复用; 同一标签页已有新鲜的就不重复截 (截视口有每秒次数上限)
export const primeViewportCapture = async (tabId?: number, windowId?: number): Promise<void> => {
    if (tabId == null || tabId < 0) return;
    if (priming || isFreshFor(primedCapture, tabId)) return;
    priming = captureVisibleTab(windowId)
        .then((dataUrl) => {
            primedCapture = { tabId, dataUrl, at: Date.now() };
        })
        // 预热失败不影响扫码: 真要点扫描时再截一次
        .catch(() => {})
        .finally(() => {
            priming = undefined;
        });
    await priming;
};

// 截视口: 有预热好的同一张画面就直接用, 预热还在路上就等它, 都没有才现截
export const takeViewportCapture = async (tabId?: number, windowId?: number): Promise<string> => {
    await priming;
    const primed = primedCapture;
    // 预热图一次性使用: 下一次扫描要重新截, 免得反复拿到同一张旧画面
    primedCapture = undefined;
    return isFreshFor(primed, tabId) ? primed.dataUrl : captureVisibleTab(windowId);
};

// 截视口并落盘: capture.html 读取后立即清除
const storeViewportCapture = async (tabId?: number, windowId?: number): Promise<boolean> => {
    try {
        const dataUrl = await takeViewportCapture(tabId, windowId);
        // 截图体积较大, 交给扩展页面读取后立即清除
        await storageArea().set({ [CAPTURE_IMAGE_KEY]: dataUrl });
        return true;
    } catch (error) {
        // 截图失败不再弹通知: 最常见的原因是标签页没有 activeTab 授权,
        // 调用方只拿到 false, 原因留在控制台供排查
        console.warn('[qrcode] 截取视口失败:', error);
        return false;
    }
};

// 截视口后在新标签页直接扫描整图。
// 兜底交给 popup 会受其窗口尺寸限制, 所以截图类降级统一走 capture.html;
// originTabId 用于关闭 capture 页时切回来源页面, 否则浏览器会切到相邻标签
export const showScreenScan = async (originTabId?: number, windowId?: number): Promise<boolean> =>
    openCapturePage('/capture.html', originTabId, windowId);

// 框选扫描的兜底: 注入不了内容脚本的页面 (扩展商店、独立 SVG、PDF 阅读器)
// 也先截一张视口图, 打开可框选的截图页让用户自己框住要看的那块。
// 截视口必须带来源页所在的窗口, 否则可能落到 popup 自己那一窗
export const showFrameScan = async (originTabId?: number): Promise<boolean> => {
    const windowId = originTabId == null
        ? undefined
        : await browser.tabs.get(originTabId).then((tab) => tab.windowId).catch(() => undefined);
    return openCapturePage('/capture.html?frame=1', originTabId, windowId);
};

// 截图页与截屏同时开始: 截屏请求先发出去 (抓的是来源页), 紧接着前台打开截图页。
// 页面先就绪时由它自己等图 (见 capture 入口), 图到了直接画, 不必等开页完成再截
const openCapturePage = async (
    path: ExtensionPage,
    originTabId?: number,
    windowId?: number,
): Promise<boolean> => {
    const captured = storeViewportCapture(originTabId, windowId);
    const tabId = await openExtensionPage(path, originTabId);
    if (tabId == null) return false;
    if (!await captured) {
        // 没有图可看: 别把一张空白的截图页留在前台
        await browser.tabs.remove(tabId).catch(() => {});
        return false;
    }
    return true;
};

// 框选扫描的分发 (右键菜单与通知里的"框选扫描"共用):
// 内容脚本优先, 在页面上直接拖框; 扩展页 (capture.html) 收不到 tabs.sendMessage,
// 走它自己连上来的端口; 都够不着 (扩展商店、独立 SVG、PDF 阅读器等) 就截张视口图开可框选的截图页。
// 右键菜单可能在 popup / devtools 里触发而没有标签页, 由 resolveActiveTabId 兜底
export const requestFrameScan = async (tabId?: number): Promise<boolean> => {
    const targetTabId = await resolveActiveTabId(tabId);
    if (targetTabId == null) return false;
    const delivered = await sendTabAction(targetTabId, 'frameScan')
        || sendExtensionPageAction(targetTabId, 'frameScan')
        || await showFrameScan(targetTabId);
    // 框选要在这一页继续扫, 别让这条通知收尾时把该页一起关掉
    if (delivered) await popupHost.keepTab(targetTabId);
    return delivered;
};

// 扫描屏幕要用到标签页 id、窗口与地址, 三者必须来自同一个标签页:
// 右键菜单在 popup / devtools 这类没有普通标签页的宿主里触发时 tab 为 undefined 或
// id 为 TAB_ID_NONE(-1), 由这里统一回落到当前活动标签页, 调用方不必各自判空
const resolveScanTarget = async (
    tabId?: number,
    windowId?: number,
    url?: string,
): Promise<{ tabId: number; windowId?: number; url?: string } | undefined> => {
    if (tabId != null && tabId >= 0) return { tabId, windowId, url };
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return undefined;
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url };
};

// 扫描屏幕: 先由内容脚本截取视口并扫描整图 (截图上还能继续框选);
// 内容脚本不可用时 (独立 SVG、Firefox 内置 PDF 阅读器) 由后台截取视口后
// 在新标签页 (capture.html) 走同一条流程。
// 内容脚本必须在收到消息时立即回执, 否则浏览器会以"消息端口关闭"拒绝, 被误判为不可用
export const requestScreenScan = async (
    tabId?: number,
    windowId?: number,
    url?: string,
): Promise<boolean> => {
    const target = await resolveScanTarget(tabId, windowId, url);
    if (!target) return false;
    if (!isSvgDocumentUrl(target.url) && await sendTabAction(target.tabId, 'scanScreen')) return true;
    return showScreenScan(target.tabId, target.windowId);
};
