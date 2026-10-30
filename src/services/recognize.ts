import {
    copyHandlers,
    errorNotice,
    resultNotice,
    runNoticeAction,
} from '@/services/decodeResultNotice';
import { showPopupNotice, type PopupNoticePayload } from '@/services/popupNotice';
import { decodeAllFromImageData, type DecodeResult } from '@/services/qrScanner';
import type { NotifyOptions, NotifyResult } from '@/composables/useNotify';
import { t } from '@/services/i18n';

// 识别流程需要的能力: 只描述"怎么提示", 不关心提示显示在哪里。
// 页面内实现见 useNoticeFallback, 其它宿主按需实现即可。
export type RecognizeHost = {
    notify(payload: PopupNoticePayload): Promise<unknown>;
    notifyDecoding(): Promise<void>;
    notifyResults(results: DecodeResult[]): Promise<boolean>;
    notifyNoResult(onRetry?: () => void): Promise<boolean>;
};

export type DecodeOutcome =
    | { status: 'ok'; results: DecodeResult[] }
    | { status: 'empty' }
    | { status: 'stale' }
    | { status: 'failed'; error: unknown };

export type RecognizeOptions = {
    host: RecognizeHost;
    // 错误提示标题, 缺省按图片识别失败处理
    errorTitle?: string;
    // 提示与结果之前执行 (如播放扫描动画), 会等待其结束
    beforeNotice?: () => Promise<void>;
    // 解码结束时回调, 通常用于停止动画
    afterDecode?: () => void;
    // 未识别到码时点击"尝试截图识别"的处理
    onRetry?: () => void;
    // 结果是否已被新一轮识别取代
    isStale?: () => boolean;
};

// 拿到图像数据的统一识别入口:
// 动画 → 加载提示 → 解码 → 结果 / 无结果重试 / 错误。
// 网页图片、本地/粘贴图片、截图都走这里, 各处只负责把数据包装成 loader。
export async function recognizeImage(
    loadImageData: () => Promise<ImageData>,
    options: RecognizeOptions,
): Promise<DecodeOutcome> {
    const { host } = options;
    const isStale = options.isStale ?? (() => false);

    // 读图与动画并行, 但提示与结果都要等动画播完
    const pending = loadImageData().then(
        (imageData) => ({ ok: true as const, imageData }),
        (error: unknown) => ({ ok: false as const, error }),
    );
    await options.beforeNotice?.();

    if (isStale()) {
        options.afterDecode?.();
        return { status: 'stale' };
    }

    await host.notifyDecoding();

    let results: DecodeResult[];
    try {
        const settled = await pending;
        if (!settled.ok) throw settled.error;
        results = await decodeAllFromImageData(settled.imageData);
    } catch (error) {
        options.afterDecode?.();
        await host.notify(
            errorNotice(
                options.errorTitle ?? t('imageFetchFailed'),
                error instanceof Error ? error.message : String(error),
            ),
        );
        return { status: 'failed', error };
    }

    options.afterDecode?.();
    if (isStale()) return { status: 'stale' };

    if (!results.length) {
        await host.notifyNoResult(options.onRetry);
        return { status: 'empty' };
    }

    await host.notifyResults(results);
    return { status: 'ok', results };
}

// 页面内兜底通知的适配: 把 popup 优先的逻辑包成 RecognizeHost。
// resolveLocal 负责在本进程内展示并返回用户操作结果。
export function createLocalHost(
    resolveLocal: (payload: PopupNoticePayload, overrides?: NotifyOptions) => Promise<NotifyResult>,
    notifyDecoding: () => Promise<void>,
    notify: (payload: PopupNoticePayload) => Promise<unknown>,
): RecognizeHost {
    return {
        notify,
        notifyDecoding,
        async notifyResults(results) {
            const payload = resultNotice(results);
            if (await showPopupNotice(payload)) return true;
            const response = await resolveLocal(payload, copyHandlers(payload));
            if (response.isConfirmed) runNoticeAction(payload.confirmAction);
            return false;
        },
        async notifyNoResult(onRetry) {
            const payload = resultNotice([]);
            if (await showPopupNotice(payload)) return true;
            const response = await resolveLocal(payload);
            if (response.dismiss === 'extra') onRetry?.();
            return false;
        },
    };
}
