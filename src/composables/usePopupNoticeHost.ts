import { onBeforeUnmount, onMounted } from 'vue';
import { useNotify, type NotifyOptions } from '@/composables/useNotify';
import { copyText } from '@/services/clipboard';
import { toOpenableUrl } from '@/services/linkText';
import {
    POPUP_NOTICE_KEY,
    type PopupNoticeAction,
    type PopupNoticeRecord,
} from '@/services/popupNotice';

const storageArea = () => browser.storage.session ?? browser.storage.local;

// 在 popup 中展示来自内容脚本的通知, 并代替内容脚本执行打开链接/复制操作
export function usePopupNoticeHost() {
    const { fire, showLoading } = useNotify();

    // 当前由 popup 展示的远程通知 ID, 用于忽略已被替换的通知
    let activeId: number | null = null;
    let port: Browser.runtime.Port | null = null;

    async function runAction(action?: PopupNoticeAction) {
        if (!action) return;
        if (action.kind === 'screenshot') {
            // popup 随后会被关闭, 由后台转告内容脚本开始区域截图
            try {
                await browser.runtime.sendMessage({ action: 'requestScreenshot' });
            } catch {
                // 页面不支持截图时保持安静, 避免再叠一层通知
            }
            return;
        }
        if (action.kind === 'open') {
            window.open(toOpenableUrl(action.value), '_blank');
            return;
        }
        await copyText(action.value);
    }

    // 复制按钮不结束通知: 复制成功后原地提示, 用户仍可点击其他按钮
    function attachCopyHandlers(
        options: NotifyOptions,
        record: PopupNoticeRecord,
    ): NotifyOptions {
        if (record.confirmAction?.kind === 'copy') {
            const value = record.confirmAction.value;
            options.onConfirm = () => copyText(value);
        }
        if (record.cancelAction?.kind === 'copy') {
            const value = record.cancelAction.value;
            options.onCancel = () => copyText(value);
        }
        return options;
    }

    // 复制按钮已就地处理, 不再重复执行对应动作
    function resolveAction(record: PopupNoticeRecord, response: Awaited<ReturnType<typeof fire>>) {
        const action = response.isConfirmed
            ? record.confirmAction
            : response.dismiss === 'cancel'
                ? record.cancelAction
                : response.dismiss === 'extra'
                    ? record.extraAction
                    : undefined;
        return action?.kind === 'copy' ? undefined : action;
    }

    async function present(record?: PopupNoticeRecord) {
        if (!record?.options) return;
        if (activeId === record.id) return;
        activeId = record.id;

        const { loading, ...options } = record.options;
        if (loading) {
            // fire 会被后续结果通知替换; 用户点击按钮或关闭通知时收起 popup
            void fire({
                ...options,
                didOpen: loading ? () => showLoading() : undefined,
            }).then(async (response) => {
                if (activeId !== record.id) return;
                activeId = null;
                // 被后续通知替换时保持 popup 打开, 由新通知继续接管
                if (response.dismiss === 'replaced') return;
                await runAction(resolveAction(record, response));
                void browser.runtime.sendMessage({ action: 'notificationResolved', id: record.id }).catch(() => {});
                window.close();
            });
            return;
        }

        const response = await fire(attachCopyHandlers({ ...options }, record));
        if (activeId !== record.id) return;
        activeId = null;

        await runAction(resolveAction(record, response));

        void browser.runtime.sendMessage({ action: 'notificationResolved', id: record.id }).catch(() => {});
        window.close();
    }

    onMounted(async () => {
        // 长连接用于接收内容脚本触发的新通知, 断开时后台会清理未处理的通知
        port = browser.runtime.connect({ name: 'popup' });
        port.onMessage.addListener((message: { action?: string; payload?: PopupNoticeRecord }) => {
            if (message?.action === 'showNotification') void present(message.payload);
        });

        // popup 打开前写入的通知在挂载后读取
        try {
            const stored = await storageArea().get(POPUP_NOTICE_KEY);
            await present(stored?.[POPUP_NOTICE_KEY] as PopupNoticeRecord | undefined);
        } catch {
            // 存储不可用时忽略, 不影响 popup 的常规功能
        }
    });

    onBeforeUnmount(() => {
        port?.disconnect();
        port = null;
    });
}
