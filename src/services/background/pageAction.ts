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


// 为指定标签页添加地址栏图标
export const addPageAction = async (tabId: number) => {
    if (!(await isVisible())) return;
    browser.pageAction.show(tabId);
};

// 为所有已打开的标签页添加/隐藏地址栏图标
const addAllPageActions = async (visible: boolean) => {
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
    if (pageActionVisible !== undefined) return pageActionVisible;
    pageActionVisiblePromise ??= browser.storage.local.get(PAGE_ACTION_KEY).then((stored) => {
        pageActionVisible = stored[PAGE_ACTION_KEY] !== false;
        return pageActionVisible;
    });
    return pageActionVisiblePromise;
};
// 切换图标显隐状态
const toggle = async () => {
    if (!IS_FIREFOX) return;
    const visible = !(await isVisible());
    await browser.storage.local.set({ [PAGE_ACTION_KEY]: visible });
    pageActionVisible = visible;
    await addAllPageActions(visible);
    browser.contextMenus.update(TOGGLE_MENU_ID, menuOptions(visible)).catch(() => {});
};


// Chrome 没有地址栏图标开关, 这项菜单只在 Firefox 建。
// 必须等右键菜单重建完成后再建, 否则会被 removeAll 一并清掉
export const addPageActionMenuItem = async () => {
    if (!IS_FIREFOX) return;
    browser.contextMenus.create({
        id: TOGGLE_MENU_ID,
        ...menuOptions(await isVisible()),
        contexts: ['action'],
    });
};

// 命中自己的开关项就执行并返回 true, 调用方据此决定要不要继续分发
export const handlePageActionClick = (menuItemId: string | number) => {
    if (menuItemId !== TOGGLE_MENU_ID) return false;
    void toggle();
    return true;
};
