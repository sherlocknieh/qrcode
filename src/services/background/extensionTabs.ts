import { storageArea } from '@/services/storage';

// WXT 的 getURL 只接受已知入口路径, 这里收紧类型以便拼接查询参数
export type ExtensionPage = `/capture.html${string}` | `/upload.html${string}`;

// 临时扩展页 (capture / upload) 关闭后要回到的页面。
// tabs.remove 只会切到相邻标签, 需要记录来源页并手动切回去
const ORIGIN_TABS_KEY = 'qrExtensionOriginTabs';

export interface ExtensionTabsOptions {
    // 打开失败时的提示 (toast 形态)
    notifyError: (title: string, text?: string) => Promise<unknown>;
}

export interface ExtensionTabs {
    // 新标签紧挨着来源页打开, 以便关闭后回到原处 (而不是相邻标签页)
    open: (path: ExtensionPage, originTabId?: number) => Promise<boolean>;
    // 由后台主动关闭: 先切回来源页再关闭
    closeAndReturn: (tabId: number) => Promise<void>;
    // 用户手动关闭: 标签页已不存在, 只需切回来源页
    returnToOrigin: (tabId: number) => Promise<void>;
}

// 临时扩展页的开合与来源页记录: 允许同时存在多个临时标签页, 因此按标签 id 存一张映射表
export const createExtensionTabs = ({ notifyError }: ExtensionTabsOptions): ExtensionTabs => {
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

    const open = async (path: ExtensionPage, originTabId?: number): Promise<boolean> => {
        try {
            const placement = await resolvePlacement(originTabId);
            const tab = await browser.tabs.create({ url: browser.runtime.getURL(path), ...placement });
            if (tab?.id != null) await rememberOrigin(tab.id, originTabId);
            return true;
        } catch (error) {
            await notifyError(
                browser.i18n.getMessage('error'),
                error instanceof Error ? error.message : String(error),
            );
            return false;
        }
    };

    const closeAndReturn = async (closingTabId: number) => {
        // 先激活来源页再关闭, 否则浏览器会自己挑一个相邻标签
        const originTabId = await takeOrigin(closingTabId);
        if (originTabId != null && originTabId !== closingTabId) {
            await browser.tabs.update(originTabId, { active: true }).catch(() => {});
        }
        await browser.tabs.remove(closingTabId).catch(() => {});
    };

    const returnToOrigin = async (tabId: number) => {
        const originTabId = await takeOrigin(tabId);
        if (originTabId != null) {
            await browser.tabs.update(originTabId, { active: true }).catch(() => {});
        }
    };

    return { open, closeAndReturn, returnToOrigin };
};
