import { FETCH_TIMEOUT_MS, describeImageError, errorNotice, errorNoticeWithScreenshot, fetchTimeoutNotice } from '@/services/decodeResultNotice';
import type { PopupNoticePayload } from '@/services/popupNotice';
import { decodeAllFromImageData, type DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';

// 扫描流程需要的能力: 只描述"怎么提示", 不关心提示显示在哪里。
// 页面内实现见 useNoticeFallback, 其它宿主按需实现即可。
export type RecognizeHost = {
    // onRetry: 通知里的"框选扫描"被点击时, 在无法由 popup 执行动作时于本进程内回调
    notify(payload: PopupNoticePayload, onRetry?: () => void): Promise<unknown>;
    notifyResults(results: DecodeResult[]): Promise<boolean>;
    // retry: 未扫到码时的重试方式, 与 onRetry 一一对应 (本地兜底执行 onRetry,
    // popup 代管时按 retry 转告页面)
    notifyNoResult(onRetry?: () => void, retry?: RetryKind): Promise<boolean>;
};

// 未扫到码后的按钮: 整屏重扫、框选一块, 或只给框选入口
// (frameScanOnly: 整页扫描本身没扫到, 不必再问"要不要重扫", 留在画面上框一块即可)
export type RetryKind = 'screenScan' | 'frameScan' | 'frameScanOnly';

export type DecodeOutcome =
    // imageSize 是解码所用图像的像素尺寸, 用于把结果的 bounds 换算到画面上
    | { status: 'ok'; results: DecodeResult[]; imageSize: { width: number; height: number } }
    | { status: 'empty' }
    | { status: 'stale' }
    | { status: 'failed'; error: unknown };

export type RecognizeOptions = {
    host: RecognizeHost;
    // 错误提示标题, 缺省按图片扫描失败处理
    errorTitle?: string;
    // 图片就绪后执行 (如播放扫描动画), 会等待其结束
    beforeNotice?: () => Promise<void>;
    // 需要先从网络取图时提供: 取图慢于阈值时先提示"正在获取图片",
    // 避免用户把下载耗时误认为扫描耗时。本地图片/截图无需提供。
    notifyFetching?: () => Promise<unknown>;
    // 解码结束时回调, 通常用于停止动画 (返回 Promise 时会等淡出结束再继续)
    afterDecode?: () => void | Promise<void>;
    // 未扫描到码时点击重试按钮的处理
    onRetry?: () => void;
    // 重试按钮的方式, 缺省为整屏重扫; 全屏扫描没扫到时只留框选入口 (没有"确定")
    noResultRetry?: RetryKind;
    // 结果是否已被新一轮扫描取代
    isStale?: () => boolean;
    // 结果通知交给调用方处理: 全屏扫描要先在画面上叠绿点, 不能直接弹通知
    deferResults?: boolean;
};

// 取图结果: 只携带结果不影响流程, 失败也在这里收口
type LoadResult =
    | { ok: true; imageData: ImageData }
    | { ok: false; error: unknown };

// 取图超过这个时间才提示"正在获取图片", 快速完成的场景不会闪一下
const FETCH_NOTICE_DELAY_MS = 150;

// 解码会长时间占住主线程: 先让出一帧, 保证扫描动画与刚冻结的截图先画上屏
const DECODE_FRAME_DELAY_MS = 50;

// 拿到图像数据的统一扫描入口:
// 获取图片提示 → 取图 → 扫描动画 → 解码 → 结果 / 无结果重试 / 错误。
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
    const settled = await loadWithFetchNotice(pending, options);

    if (isStale()) {
        await options.afterDecode?.();
        return { status: 'stale' };
    }

    if (!settled.ok) {
        await notifyFailure(options, settled.error);
        return { status: 'failed', error: settled.error };
    }

    // 图片已经在手: 先起扫描动画, 动画在解码期间一直循环, 结束后由 afterDecode 收起
    await options.beforeNotice?.();
    await new Promise((resolve) => setTimeout(resolve, DECODE_FRAME_DELAY_MS));

    if (isStale()) {
        await options.afterDecode?.();
        return { status: 'stale' };
    }

    let results: DecodeResult[];
    try {
        results = await decodeAllFromImageData(settled.imageData);
    } catch (error) {
        await notifyFailure(options, error);
        return { status: 'failed', error };
    }

    await options.afterDecode?.();
    if (isStale()) return { status: 'stale' };

    if (!results.length) {
        await host.notifyNoResult(options.onRetry, options.noResultRetry);
        return { status: 'empty' };
    }

    if (!options.deferResults) await host.notifyResults(results);
    return {
        status: 'ok',
        results,
        imageSize: { width: settled.imageData.width, height: settled.imageData.height },
    };
}

// 取图慢于阈值时先提示"正在获取图片", 图片就绪后由扫描动画接替;
// 远超阈值仍没结果时换成"改用扫描屏幕"的提示 (图片之后到达也照样继续扫描)
async function loadWithFetchNotice(
    pending: Promise<LoadResult>,
    options: RecognizeOptions,
): Promise<LoadResult> {
    const { notifyFetching, host, onRetry } = options;
    if (!notifyFetching) return pending;

    const settled = await Promise.race([
        pending.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_NOTICE_DELAY_MS)),
    ]);
    if (settled) return settled.value;

    await notifyFetching();
    // 取图卡住时干等下去只能让用户以为扫描挂了, 给出截屏扫描这个保底出口
    const timer = setTimeout(() => {
        void host.notify(fetchTimeoutNotice(), onRetry);
    }, FETCH_TIMEOUT_MS);
    try {
        return await pending;
    } finally {
        clearTimeout(timer);
    }
}

// 取图或解码失败: 停止动画并提示; 有重试出口时顺带提供"框选扫描"
async function notifyFailure(options: RecognizeOptions, error: unknown): Promise<void> {
    await options.afterDecode?.();
    const title = options.errorTitle ?? t('imageFetchFailed');
    const text = describeImageError(error);
    await options.host.notify(
        options.onRetry
            ? errorNoticeWithScreenshot(title, text)
            : errorNotice(title, text),
        options.onRetry,
    );
}
