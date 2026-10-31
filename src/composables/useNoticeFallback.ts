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
// 内容脚本与独立识别页共用, 保证两种入口的提示行为一致。
export function useNoticeFallback() {
    const { fire, showLoading } = useNotify();

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
    async function deliver(payload: PopupNoticePayload, onRetry?: () => void): Promise<boolean> {
        if (await showPopupNotice(payload)) return true;

        const interactive = Boolean(
            payload.confirmAction || payload.cancelAction || payload.extraAction,
        );
        if (!interactive) {
            void fireLocal(payload);
            return false;
        }

        const response = await fireLocal(payload, copyHandlers(payload));
        if (response.dismiss === 'extra') onRetry?.();
        // 复制按钮已在页面内就地处理, 打开类动作由本进程执行
        if (response.isConfirmed) runNoticeAction(payload.confirmAction);
        if (response.dismiss === 'cancel') runNoticeAction(payload.cancelAction);
        return false;
    }

    // 只提示, 不需要用户选择的通知; onRetry 对应通知里的"改用截图识别"按钮
    function notify(payload: PopupNoticePayload, onRetry?: () => void): Promise<boolean> {
        return deliver(payload, onRetry);
    }

    // 识别结果: popup 可用时由 popup 直接完成打开/复制。
    // 返回 true 表示通知已由 popup 接管 (调用方可以关闭自己的临时页面)
    function notifyResults(results: DecodeResult[]): Promise<boolean> {
        return deliver(resultNotice(results));
    }

    // 识别中的加载提示: 等待一帧让提示先渲染, 再做计算密集的解码
    async function notifyDecoding(): Promise<void> {
        await notify(decodingNotice());
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 取图耗时提示: 网络取图期间先说明"正在获取图片"并解释原因,
    // 图片就绪后由"正在识别"通知替换, 避免用户把下载时间当成识别时间
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

    // 未识别到码: 只有调用方真的能再截一次图时才提供"改用截图识别"
    function notifyNoResult(onRetry?: () => void): Promise<boolean> {
        return deliver(resultNotice([], { retryScreenshot: Boolean(onRetry) }), onRetry);
    }

    // 供 recognizeImage 使用的宿主: 与上面的函数同一套实现
    const host: RecognizeHost = { notify, notifyDecoding, notifyResults, notifyNoResult };

    return { fireLocal, notify, notifyDecoding, notifyFetching, notifyNoResult, notifyResults, host };
}
