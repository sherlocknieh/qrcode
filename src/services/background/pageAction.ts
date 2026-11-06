import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';

// Firefox 地址栏图标 (page action) 相关管理

const IS_FIREFOX = import.meta.env.FIREFOX;
const PAGE_ACTION_KEY = 'pageActionVisible';
const TOGGLE_MENU_ID = 'togglePageAction';

let pageActionVisible: boolean | undefined;
let pageActionVisiblePromise: Promise<boolean> | undefined;


const menuIcon = (name: MenuIconName) => IS_FIREFOX ? { icons: { 16: getMenuIcon(name) } } : {};
const menuOptions = (visible: boolean) => ({
    title: browser.i18n.getMessage(visible ? 'hidePageAction' : 'showPageAction'),
    ...menuIcon(visible ? 'hide' : 'show'),
});


// 为所有已打开的标签页添加/隐藏地址栏图标
const syncPageActions = async (visible: boolean) => {
    const pageAction = browser.pageAction;
    if (!pageAction) return;
    const tabs = await browser.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
        if (tab.id == null) return;
        (visible ? pageAction.show(tab.id) : pageAction.hide(tab.id));
    }));
};

// 查询图标显隐状态
const isVisible = async () => {
    // 优先从内存缓存中读取, 避免频繁访问 storage
    if (pageActionVisible !== undefined) return pageActionVisible;
    // 从 storage 中读取, 并缓存结果
    pageActionVisiblePromise ??= browser.storage.local.get(PAGE_ACTION_KEY)
    .then((data) => {
        pageActionVisible = data[PAGE_ACTION_KEY] !== false;
        // 返回缓存结果
        return pageActionVisible;
    })
    .catch((error) => {
        pageActionVisiblePromise = undefined;
        throw error;
    });
    // 异步返回 Promise, 避免阻塞调用方
    return pageActionVisiblePromise;
};

// 切换图标显隐状态
const toggle = async () => {
    if (!IS_FIREFOX) return;
    const visible = !(await isVisible());
    await browser.storage.local.set({ [PAGE_ACTION_KEY]: visible });
    pageActionVisible = visible;
    await syncPageActions(visible);
    browser.contextMenus.update(TOGGLE_MENU_ID, menuOptions(visible)).catch(() => {});
};

// 为新增的标签页添加地址栏图标
export const addPageAction = async (tabId: number) => {
    if (!(await isVisible())) return;
    browser.pageAction.show(tabId);
};


// 添加"地址栏图标开关"右键菜单项
export const addPageActionMenuItem = async () => {
    if (!IS_FIREFOX) return;
    browser.contextMenus.create({
        id: TOGGLE_MENU_ID,
        ...menuOptions(await isVisible()),
        contexts: ['action'],
    });
};

// 处理地址栏图标开关菜单项点击事件
export const handlePageActionClick = (menuItemId: string | number) => {
    if (menuItemId !== TOGGLE_MENU_ID) return false;
    void toggle();
    return true;
};
