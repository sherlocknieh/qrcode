import { storageArea } from '@/services/storage';

// WXT 的 getURL 只接受已知入口路径, 这里收紧类型以便拼接查询参数
export type ExtensionPage = `/capture.html${string}` | `/upload.html${string}`;

// 临时扩展页 (capture / upload) 关闭后要回到的页面。
// tabs.remove 只会切到相邻标签, 需要记录来源页并手动切回去
const ORIGIN_TABS_KEY = 'qrExtensionOriginTabs';

// 取来源页的窗口与位置: 传了 index 才会紧挨源页, 否则 tabs.create 会追加到标签栏末尾
const resolvePlacement = async (
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

// 允许同时存在多个临时标签页, 因此按标签 id 存一张映射表
const rememberOrigin = async (extensionTabId: number, originTabId?: number) => {
    if (originTabId == null) return;
    const stored = await storageArea().get(ORIGIN_TABS_KEY);
    const map = { ...(stored?.[ORIGIN_TABS_KEY] as Record<string, number> | undefined) };
    map[String(extensionTabId)] = originTabId;
    await storageArea().set({ [ORIGIN_TABS_KEY]: map }).catch(() => {});
};

// 取出并清除某个扩展页记录的来源页
const takeOrigin = async (extensionTabId: number): Promise<number | undefined> => {
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

// 临时扩展页紧挨着来源页打开, 关闭后才能回到原处 (而不是相邻标签页)
export const openExtensionPage = async (
    path: ExtensionPage,
    originTabId?: number,
): Promise<number | undefined> => {
    try {
        const placement = await resolvePlacement(originTabId);
        const tab = await browser.tabs.create({ url: browser.runtime.getURL(path), ...placement });
        if (tab?.id == null) return undefined;
        await rememberOrigin(tab.id, originTabId);
        return tab.id;
    } catch (error) {
        // 打开失败不再弹通知: 调用方只关心成败, 原因留在控制台供排查
        console.warn('[qrcode] 打开临时扩展页失败:', error);
        return undefined;
    }
};

// 由后台主动关闭: 先切回来源页再关闭, 否则浏览器会自己挑一个相邻标签
export const closeTabAndReturn = async (closingTabId: number) => {
    const originTabId = await takeOrigin(closingTabId);
    if (originTabId != null && originTabId !== closingTabId) {
        await browser.tabs.update(originTabId, { active: true }).catch(() => {});
    }
    await browser.tabs.remove(closingTabId).catch(() => {});
};

// 用户手动点 X 关闭: 标签页已不存在, 只需切回来源页
export const returnToOrigin = async (tabId: number) => {
    const originTabId = await takeOrigin(tabId);
    if (originTabId != null) {
        await browser.tabs.update(originTabId, { active: true }).catch(() => {});
    }
};

// 扩展页所在的标签页收到 tabs.sendMessage 的连接会直接失败,
// 由页面挂载时自己连一个端口过来; 后台据此把动作推回持有截图的那一页
const pagePorts = new Map<number, Browser.runtime.Port>();

export const connectExtensionPage = (port: Browser.runtime.Port) => {
    if (port.name !== 'extensionPage') return;
    const tabId = port.sender?.tab?.id;
    if (tabId == null) return;
    pagePorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
        if (pagePorts.get(tabId) === port) pagePorts.delete(tabId);
    });
};

// 给指定标签页里的扩展页推一个动作; 返回是否推到了
export const sendExtensionPageAction = (tabId: number, action: string): boolean => {
    const port = pagePorts.get(tabId);
    if (!port) return false;
    try {
        port.postMessage({ action });
        return true;
    } catch {
        pagePorts.delete(tabId);
        return false;
    }
};
