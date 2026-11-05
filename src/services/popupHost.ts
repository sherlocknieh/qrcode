// 后台侧的 popup 宿主: 通知落盘与推送、窗口打开, 以及窗口开合的竞态兜底
// popup 是否打开只能由后台感知 (长连接 + openPopup 的返回时机), 所以这一整块状态收在这里,
// 入口文件只负责把拿到的消息转进来
import { closeTabAndReturn } from '@/services/background/extensionTabs';
import {
    POPUP_NOTICE_KEY,
    type PopupNoticePayload,
    type PopupNoticeRecord,
} from '@/services/popupNotice';
import { storageArea } from '@/services/storage';

// 打开后这段时间内的新通知交给 popup 自读, 免得重复 openPopup 顶掉窗口
const POPUP_OPEN_GRACE = 1500;
// 断开事件晚于真实点击, 关闭后这段时间仍算"开着", 让这一击去关 popup
const POPUP_CLOSE_GRACE = 600;

// 关闭通知里提到的标签页 (独立扫描页发起): 先切回来源页再关闭
const createPopupHost = (closeTab: (tabId: number) => void | Promise<unknown>) => {
    let port: Browser.runtime.Port | null = null;   // popup 窗口长连接
    let opening = false;                            // popup 窗口是否正在打开
    let lastOpenAt = 0;                             // popup 上次打开时间
    let lastCloseAt = 0;                            // popup 上次关闭时间
    let noticeSeq = 0;                              // 通知自增 id, 用于丢弃过期记录

    // 打开 popup 窗口: 优先用 Firefox 地址栏按钮, 不可用或被拒绝时回退工具栏图标
    const open = async () => {
        // 类型声明里 pageAction 没有 openPopup, 但 Firefox 运行时提供
        const pageAction = browser.pageAction as unknown as { openPopup?: () => Promise<void> } | undefined;
        try {
            if (!import.meta.env.FIREFOX || !pageAction?.openPopup) throw new Error('unavailable');
            await pageAction.openPopup();
        } catch {
            await browser.action.openPopup();
        }
        lastOpenAt = Date.now();
    };

    // 打开 popup 失败时撤掉刚才落盘的通知, 避免下次打开时还弹一条已经没人处理的
    const clearIfCurrent = async (id: number) => {
        const stored = await storageArea().get(POPUP_NOTICE_KEY);
        const current = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
        if (current?.id === id) await storageArea().remove(POPUP_NOTICE_KEY);
    };

    // 通知结束 (popup 展示完毕或 popup 被关闭) 后清理记录;
    // 独立扫描页 (capture.html) 发起的通知会把该标签页一并关闭
    const finish = async (id?: number) => {
        const stored = await storageArea().get(POPUP_NOTICE_KEY);
        const current = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
        if (!current) return;
        if (id != null && current.id !== id) return;
        await storageArea().remove(POPUP_NOTICE_KEY);
        if (current.closeTabId != null) await closeTab(current.closeTabId);
    };

    // 返回 false 表示当前无法显示 popup, 内容脚本将回退到页面内通知
    const showNotification = async (
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

        if (port) {
            try {
                port.postMessage({ action: 'showNotification', payload: record });
                return true;
            } catch {
                port = null;
            }
        }

        // popup 正在打开或刚刚打开: 它挂载后会读取最新通知
        if (opening || Date.now() - lastOpenAt < POPUP_OPEN_GRACE) return true;

        opening = true;
        try {
            await open();
            return true;
        } catch {
            await clearIfCurrent(record.id);
            return false;
        } finally {
            opening = false;
        }
    };

    // 内容脚本点空白处前先问一句通知窗口是否还开着: 开着说明这一下是去关它的
    const isOpen = () => Boolean(port) || opening || Date.now() - lastCloseAt < POPUP_CLOSE_GRACE;

    // 长连接是否还在: 只有连着才能把通知直接推过去, 也说明窗口确实开着
    const isConnected = () => port != null;

    // popup 建立长连接: 补推挂载期间写入的通知, 断开时收起未处理的通知
    const connect = (incoming: Browser.runtime.Port) => {
        if (incoming.name !== 'popup') return;
        port = incoming;
        // 补推是为了堵住 openPopup 与端口连接之间的空档, 否则这条通知会一直留在存储里
        void storageArea().get(POPUP_NOTICE_KEY).then((stored) => {
            const record = stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined;
            if (record && port === incoming) incoming.postMessage({ action: 'showNotification', payload: record });
        }).catch(() => {});
        incoming.onDisconnect.addListener(() => {
            if (port === incoming) port = null;
            lastOpenAt = 0;
            lastCloseAt = Date.now();
            // popup 关闭后清掉未处理的通知, 避免下次打开时旧通知再次出现;
            // 通知来自独立扫描页时同时关闭该标签页 (用户关掉通知即视为结束)
            void finish().catch(() => {});
        });
    };

    return { open, showNotification, finish, isOpen, isConnected, connect };
};

export const popupHost = createPopupHost(closeTabAndReturn);
