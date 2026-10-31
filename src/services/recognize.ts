import { errorNotice, errorNoticeWithScreenshot } from '@/services/decodeResultNotice';
import type { PopupNoticePayload } from '@/services/popupNotice';
import { decodeAllFromImageData, type DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';

// 识别流程需要的能力: 只描述"怎么提示", 不关心提示显示在哪里。
// 页面内实现见 useNoticeFallback, 其它宿主按需实现即可。
export type RecognizeHost = {
    // onRetry: 通知里的"改用截图识别"被点击时, 在无法由 popup 执行动作时于本进程内回调
    notify(payload: PopupNoticePayload, onRetry?: () => void): Promise<unknown>;
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
    // 图片就绪、识别提示出现后执行 (如播放扫描动画), 会等待其结束
    beforeNotice?: () => Promise<void>;
    // 需要先从网络取图时提供: 取图慢于阈值时先提示"正在获取图片",
    // 避免用户把下载耗时误认为识别耗时。本地图片/截图无需提供。
    notifyFetching?: () => Promise<unknown>;
    // 解码结束时回调, 通常用于停止动画
    afterDecode?: () => void;
    // 未识别到码时点击"尝试截图识别"的处理
    onRetry?: () => void;
    // 结果是否已被新一轮识别取代
    isStale?: () => boolean;
};

// 取图结果: 只携带结果不影响流程, 失败也在这里收口
type LoadResult =
    | { ok: true; imageData: ImageData }
    | { ok: false; error: unknown };

// 取图超过这个时间才提示"正在获取图片", 快速完成的场景不会闪一下
const FETCH_NOTICE_DELAY_MS = 150;

// 拿到图像数据的统一识别入口:
// 获取图片提示 → 取图 → 识别提示 → 扫描动画 → 解码 → 结果 / 无结果重试 / 错误。
// 网页图片、本地/粘贴图片、截图都走这里, 各处只负责把数据包装成 loader。
export async function recognizeImage(
    loadImageData: () => Promise<ImageData>,
    options: RecognizeOptions,
): Promise<DecodeOutcome> {
    const { host } = options;
    const isStale = options.isStale ?? (() => false);

    // 只有需要下载的图片才可能耗时, 本地图片/截图不传 notifyFetching
    const pending = loadImageData().then(
        (imageData): LoadResult => ({ ok: true, imageData }),
        (error: unknown): LoadResult => ({ ok: false, error }),
    );
    const settled = await loadWithFetchNotice(pending, options.notifyFetching);

    if (isStale()) {
        options.afterDecode?.();
        return { status: 'stale' };
    }

    if (!settled.ok) {
        await notifyFailure(options, settled.error);
        return { status: 'failed', error: settled.error };
    }

    // 图片已经在手: 先给识别提示, 再播扫描动画, 最后解码
    await host.notifyDecoding();
    await options.beforeNotice?.();

    if (isStale()) {
        options.afterDecode?.();
        return { status: 'stale' };
    }

    let results: DecodeResult[];
    try {
        results = await decodeAllFromImageData(settled.imageData);
    } catch (error) {
        await notifyFailure(options, error);
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

// 取图慢于阈值时先提示"正在获取图片", 图片就绪后由识别提示替换
async function loadWithFetchNotice(
    pending: Promise<LoadResult>,
    notifyFetching?: () => Promise<unknown>,
): Promise<LoadResult> {
    if (!notifyFetching) return pending;

    const settled = await Promise.race([
        pending.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_NOTICE_DELAY_MS)),
    ]);
    if (settled) return settled.value;

    await notifyFetching();
    return pending;
}

// 取图或解码失败: 停止动画并提示; 有重试出口时顺带提供"改用截图识别"
async function notifyFailure(options: RecognizeOptions, error: unknown): Promise<void> {
    options.afterDecode?.();
    const title = options.errorTitle ?? t('imageFetchFailed');
    const text = error instanceof Error ? error.message : String(error);
    await options.host.notify(
        options.onRetry
            ? errorNoticeWithScreenshot(title, text)
            : errorNotice(title, text),
        options.onRetry,
    );
}
