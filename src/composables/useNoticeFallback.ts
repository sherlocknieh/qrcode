import { useNotify, type NotifyOptions } from '@/composables/useNotify';
import {
    copyHandlers,
    decodingNotice,
    resultNotice,
    runNoticeAction,
} from '@/services/decodeResultNotice';
import type { PopupNoticePayload } from '@/services/popupNotice';
import { showPopupNotice } from '@/services/popupNotice';
import type { DecodeResult } from '@/services/qrScanner';
import type { RecognizeHost } from '@/services/recognize';
import { t } from '@/services/i18n';

// 通知统一策略: 优先在 popup 中展示, 失败时回退到当前页面。
// 内容脚本与独立扫描页共用, 保证两种入口的提示行为一致。
export type NoticeFallbackOptions = {
    // 独立扫描页使用: 交给 popup 的通知带上标记, 由后台在通知结束后关闭本标签页
    closeOriginTab?: boolean;
    // 通知退回页面内展示时, 在用户结束通知后调用 (被新通知替换不算结束)
    onLocalNoticeDone?: () => void;
};

export function useNoticeFallback(options: NoticeFallbackOptions = {}) {
    const { fire, showLoading } = useNotify();

    // 标记来源, 由后台在通知结束时关闭该标签页
    function tag(payload: PopupNoticePayload): PopupNoticePayload {
        return options.closeOriginTab ? { ...payload, closeOriginTab: true } : payload;
    }

    // 页面内通知结束: 被后续通知替换时标签页仍有内容, 只有真正结束才回调
    function settleLocal(response: { dismiss?: string }) {
        if (response.dismiss === 'replaced') return;
        options.onLocalNoticeDone?.();
    }

    // popup 无法显示时的页面内兜底通知
    function fireLocal(payload: PopupNoticePayload, overrides: NotifyOptions = {}) {
        const { loading, ...options } = payload.options;
        return fire({
            ...options,
            ...overrides,
            didOpen: loading ? () => showLoading() : undefined,
        });
    }

    // 统一投递: 先交给 popup, 不可用时在页面内展示。
    // 带动作按钮的通知要等用户选择, 纯提示则不阻塞流程。
    async function deliver(rawPayload: PopupNoticePayload, onRetry?: () => void): Promise<boolean> {
        const payload = tag(rawPayload);
        if (await showPopupNotice(payload)) return true;

        const interactive = Boolean(
            payload.confirmAction || payload.cancelAction || payload.extraAction,
        );
        if (!interactive) {
            // 纯提示不阻塞流程, 但仍要等用户结束通知后再回调
            void fireLocal(payload).then(settleLocal);
            return false;
        }

        const response = await fireLocal(payload, copyHandlers(payload));
        if (response.dismiss === 'extra') onRetry?.();
        // 复制按钮已在页面内就地处理, 打开类动作由本进程执行
        if (response.isConfirmed) runNoticeAction(payload.confirmAction);
        if (response.dismiss === 'cancel') runNoticeAction(payload.cancelAction);
        settleLocal(response);
        return false;
    }

    // 只提示, 不需要用户选择的通知; onRetry 对应通知里的"改用截图扫描"按钮
    function notify(payload: PopupNoticePayload, onRetry?: () => void): Promise<boolean> {
        return deliver(payload, onRetry);
    }

    // 扫描结果: popup 可用时由 popup 直接完成打开/复制。
    // 返回 true 表示通知已由 popup 接管 (调用方可以关闭自己的临时页面)。
    // pickHint: 画面上同时给出可点选的蓝点时, 在批量结果里说明怎么点
    function notifyResults(
        results: DecodeResult[],
        options: { pickHint?: boolean } = {},
    ): Promise<boolean> {
        return deliver(resultNotice(results, options));
    }

    // 扫描中的加载提示: 等待一帧让提示先渲染, 再做计算密集的解码
    async function notifyDecoding(): Promise<void> {
        await notify(decodingNotice());
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 取图耗时提示: 网络取图期间先说明"正在获取图片"并解释原因,
    // 图片就绪后由"正在扫描"通知替换, 避免用户把下载时间当成扫描时间
    async function notifyFetching(): Promise<void> {
        await notify({
            options: {
                toast: true,
                icon: 'info',
                title: t('fetchingImage'),
                text: t('fetchingImageHint'),
                showCloseButton: true,
                loading: true,
            },
        });
    }

    // 未扫描到码: 只有调用方真的能再截一次图时才提供"改用截图扫描"
    function notifyNoResult(onRetry?: () => void): Promise<boolean> {
        return deliver(resultNotice([], { retryScreenshot: Boolean(onRetry) }), onRetry);
    }

    // 供 recognizeImage 使用的宿主: 与上面的函数同一套实现
    const host: RecognizeHost = { notify, notifyDecoding, notifyResults, notifyNoResult };

    return { fireLocal, notify, notifyDecoding, notifyFetching, notifyNoResult, notifyResults, host };
}
