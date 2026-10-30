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

    // 只提示, 不需要用户选择的通知
    async function notify(payload: PopupNoticePayload): Promise<boolean> {
        if (await showPopupNotice(payload)) return true;
        fireLocal(payload);
        return false;
    }

    // 识别结果: popup 可用时由 popup 直接完成打开/复制。
    // 返回 true 表示通知已由 popup 接管 (调用方可以关闭自己的临时页面)
    async function notifyResults(results: DecodeResult[]): Promise<boolean> {
        const payload = resultNotice(results);
        if (await showPopupNotice(payload)) return true;

        // popup 不可用时在页面内展示: 复制按钮就地执行, 打开链接需要本进程处理
        const response = await fireLocal(payload, copyHandlers(payload));
        if (response.isConfirmed) runNoticeAction(payload.confirmAction);
        return false;
    }

    // 识别中的加载提示: 等待一帧让提示先渲染, 再做计算密集的解码
    async function notifyDecoding(): Promise<void> {
        await notify(decodingNotice());
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 未识别到码: 提供"重新截图"出口, 用户点击后由调用方决定重试方式。
    // 返回 true 表示通知已由 popup 接管
    async function notifyNoResult(onRetry?: () => void): Promise<boolean> {
        const payload = resultNotice([]);
        if (await showPopupNotice(payload)) return true;
        const response = await fireLocal(payload);
        if (response.dismiss === 'extra') onRetry?.();
        return false;
    }

    // 供 recognizeImage 使用的宿主: 与上面的函数同一套实现
    const host: RecognizeHost = { notify, notifyDecoding, notifyResults, notifyNoResult };

    return { fireLocal, notify, notifyDecoding, notifyNoResult, notifyResults, host };
}
