import { getMenuIcon, type MenuIconName } from '@/services/menuIcons';

// Firefox 地址栏图标 (page action): 显隐状态、应用到标签页, 以及右键菜单里的开关项。
// 单标签的显隐在导航后会重置, 所以既要能全量应用也要能只作用于一个标签页;
// 开关菜单项的标题与图标完全由这份状态决定, 因此一并在本模块里创建与刷新。
const IS_FIREFOX = import.meta.env.FIREFOX;
// Firefox 地址栏图标显/隐状态持久化储存键
const PAGE_ACTION_KEY = 'pageActionVisible';
const TOGGLE_MENU_ID = 'togglePageAction';

// 只要未明确设置为 false, 就取 true (默认显示)
const isVisible = async () => {
    const stored = await browser.storage.local.get(PAGE_ACTION_KEY);
    return stored[PAGE_ACTION_KEY] !== false;
};

// Firefox 支持为菜单项指定自定义图标 (Chrome 不支持, 因此仅在 Firefox 构建中传入);
// 图标内嵌在 src/services/menuIcons.ts 中, 颜色跟随菜单主题自动变化
const menuIcon = (name: MenuIconName) => IS_FIREFOX
    ? { icons: { 16: getMenuIcon(name) } }
    : {};

// 已有图标故菜单标题不再拼 emoji
const menuOptions = (visible: boolean) => ({
    title: browser.i18n.getMessage(visible ? 'hidePageAction' : 'showPageAction'),
    ...menuIcon(visible ? 'hide' : 'show'),
});

// 把显隐状态应用到标签页: 不传 tabId 表示全量应用, 传了则只作用于该标签页
const apply = async (visible: boolean, tabId?: number) => {
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

// 菜单项表达的是"切换": 当前状态查询、取反、持久化、应用与菜单项刷新都收敛在这里
const toggle = async () => {
    if (!IS_FIREFOX) return;
    const visible = !(await isVisible());
    await browser.storage.local.set({ [PAGE_ACTION_KEY]: visible });
    await apply(visible);
    browser.contextMenus.update(TOGGLE_MENU_ID, menuOptions(visible)).catch(() => {});
};

// 标签页加载完成后恢复显隐: 只处理这一个标签页, 不必全量扫一遍
export const showPageAction = async (tabId: number) => {
    if (!IS_FIREFOX || !(await isVisible())) return;
    await apply(true, tabId);
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
