import { useNotify, type NotifyOptions } from '@/composables/useNotify';
import {
    copyHandlers,
    multiFoundNotice,
    resultNotice,
    runNoticeAction,
} from '@/services/decodeResultNotice';
import type { PopupNoticeAction, PopupNoticePayload } from '@/services/popupNotice';
import { showPopupNotice } from '@/services/popupNotice';
import type { DecodeResult } from '@/services/qrScanner';
import type { RecognizeHost, RetryKind } from '@/services/recognize';
import { t } from '@/services/i18n';

// 通知统一策略: 优先在 popup 中展示, 失败时回退到当前页面。
// 内容脚本与独立扫描页共用, 保证两种入口的提示行为一致。
export type NoticeFallbackOptions = {
    // 独立扫描页使用: 交给 popup 的通知带上标记, 由后台在通知结束后关闭本标签页;
    // 传函数时在每次投递前求值, 供多码点选只让最后一条通知收尾
    closeOriginTab?: boolean | (() => boolean);
    // 通知退回页面内展示时, 在用户结束通知后调用 (被新通知替换不算结束)
    onLocalNoticeDone?: () => void;
};

export function useNoticeFallback(options: NoticeFallbackOptions = {}) {
    const { fire, showLoading } = useNotify();

    // 标记来源, 由后台在通知结束时关闭该标签页
    function tag(payload: PopupNoticePayload): PopupNoticePayload {
        const close = typeof options.closeOriginTab === 'function'
            ? options.closeOriginTab()
            : options.closeOriginTab;
        return close ? { ...payload, closeOriginTab: true } : payload;
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

    // 只提示, 不需要用户选择的通知; onRetry 对应通知里的"框选扫描"按钮
    function notify(payload: PopupNoticePayload, onRetry?: () => void): Promise<boolean> {
        return deliver(payload, onRetry);
    }

    // 扫描结果: popup 可用时由 popup 直接完成打开/复制。
    // 返回 true 表示通知已由 popup 接管 (调用方可以关闭自己的临时页面)。
    function notifyResults(results: DecodeResult[]): Promise<boolean> {
        return deliver(resultNotice(results));
    }

    // 画面上的绿框已经列出全部结果: 多码时只弹一条"扫到多个码"的轻提示,
    // 内容等用户点某个码再逐条展示, 否则通知列表和绿框会把同一批码列两遍;
    // 有码定位不到时绿框会漏, 仍用列表通知把全部结果补齐
    function notifyPickedResults(results: DecodeResult[]): Promise<boolean> {
        const allLocated = results.every((result) => result.bounds);
        if (results.length > 1 && allLocated) return notify(multiFoundNotice(results));
        return notifyResults(results);
    }

    // 取图耗时提示: 网络取图期间先说明"正在获取图片"并解释原因,
    // 避免用户把下载时间当成扫描时间。
    // 图片就绪后由"正在扫描"提示接替 (见 notifyDecoding), 两者都是普通通知,
    // 后一条交给 popup 时直接替换前一条, 窗口原地换文案、不必关掉再重开
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

    // 图片取到后的"正在扫描": 只在需要先取图的跨域路线上接替取图提示,
    // 解码期间 popup 保持开着; 结果通知到来时再把它替换掉
    async function notifyDecoding(): Promise<void> {
        await notify({
            options: {
                toast: true,
                icon: 'info',
                title: t('decodingQR'),
                showCloseButton: true,
                loading: true,
            },
        });
    }

    // 未扫描到码: 只有调用方真的能再试一次时才给出重试按钮,
    // 按钮方式 (整屏重扫 / 框选) 由调用方决定。
    // frameScanOnly 例外: 整页扫描没扫到时不问"是否重扫", 只留框选入口, 也就不需要 onRetry
    // (点按钮由 popup 或本页触发框选, 真正的退出看用户在画面上是单击还是拖框)
    function notifyNoResult(onRetry?: () => void, retry: RetryKind = 'screenScan'): Promise<boolean> {
        const frameScanOnly = retry === 'frameScanOnly';
        const showRetry = frameScanOnly || Boolean(onRetry);
        const action: PopupNoticeAction = frameScanOnly ? { kind: 'frameScan' } : { kind: retry };
        return deliver(resultNotice([], {
            retry: showRetry ? action : false,
        }), onRetry);
    }

    // 供 recognizeImage 使用的宿主: 与上面的函数同一套实现
    const host: RecognizeHost = { notify, notifyDecoding, notifyResults, notifyNoResult };

    return { fireLocal, notify, notifyDecoding, notifyFetching, notifyPickedResults, notifyNoResult, notifyResults, host };
}
