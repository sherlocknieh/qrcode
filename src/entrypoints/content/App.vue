<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

// 非UI组件
import { getImageDataFromDataUrl, loadImageDataFromUrl, type DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage } from '@/services/messaging';
import { errorNotice, warningNotice } from '@/services/decodeResultNotice';
import { recognizeImage, type DecodeOutcome } from '@/services/recognize';
import { measureImageRect } from '@/services/imageRect';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';
import ScanMarks from '@/components/ScanMarks.vue';

import { useScreenshot, type ScreenshotCapture, type ScreenshotResult, type ScreenshotSession } from '@/composables/useScreenshot';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useImagePasteOverlay } from '@/composables/useImagePasteOverlay';
import { toMarkRects, useCodePicker, type PickAnchor } from '@/composables/useCodePicker';
import type { ScanRect } from '@/components/ScanOverlay.vue';

const { startScreenshot } = useScreenshot();
let clearActiveMarks = () => {};
const { notify, notifyFetching, notifyResults, host } = useNoticeFallback({
    onLocalNoticeDone: () => clearActiveMarks(),
});
const scanAnimation = useScanAnimation();
const imagePasteOverlay = useImagePasteOverlay();

// 命中码后统一在画面上叠蓝点: 整屏截屏 / 框选截图 / 网页图片只是锚点不同
const picker = useCodePicker({ notifyResults });
const marks = picker.marks;
const pickMark = picker.pick;
const clearMarks = picker.clear;

// 码都在图标实际显示的区域里定位: 只有可定位的码才叠蓝点, 其余仍由结果列表列出
function showResults(outcome: Extract<DecodeOutcome, { status: 'ok' }>, anchor: PickAnchor) {
    picker.show(outcome.results, anchor);
    return notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
}

// 整屏截图: 图像就是视口的拷贝, 锚点即整个视口
function viewportAnchor(imageSize: { width: number; height: number }, scroll = { x: window.scrollX, y: window.scrollY }): PickAnchor {
    const width = window.innerWidth;
    return {
        rect: { x: 0, y: 0, width, height: window.innerHeight },
        imageSize,
        scroll,
        viewportWidth: width,
        followScroll: true,
    };
}

// 内容脚本的主流程函数，根据不同的消息类型调用相应的处理逻辑
const mainProcess = (
    message: { action?: string; imageUrl?: string },
    _sender: Browser.runtime.MessageSender,
    sendResponse: (response?: { success: boolean }) => void,
) => {
    if (message.action === 'notificationResolved') {
        clearActiveMarks();
        return;
    }
    // 新一轮扫描开始: 先收起上一张冻结的截图, 否则旧结果会挡住新的提示与蓝点
    if (message.action !== undefined) {
        activeShot?.close();
        activeShot = null;
    }
    if (message.action === 'decodeQR' && message.imageUrl) {
        handleImageUrl(message.imageUrl);
    }
    if (message.action === 'screenshotQR') {
        handleScreenshot();
    }
    if (message.action === 'scanFullScreen') {
        handleQuickScreenshot();
    }
    if (message.action === 'scanImageInline') {
        imagePasteOverlay.open();
    }
    // 立即回执: 后台以"是否收到回应"判断内容脚本是否可用, 不回应会被当成不可用而回退到新标签页
    sendResponse({ success: true });
    return false;
};

// 当组件挂载时，注册消息监听器，等待来自背景脚本的指令
onMounted(() => {
    browser.runtime.onMessage.addListener(mainProcess);
});

// 当组件卸载时，移除消息监听器，避免内存泄漏
onBeforeUnmount(() => {
    browser.runtime.onMessage.removeListener(mainProcess);
    void scanAnimation.stop();
    clearMarks();
    activeShot?.close();
    activeShot = null;
    imagePasteOverlay.close();
});

// 找到右键扫描的图片元素; 背景图等找不到元素时返回 undefined
function findImageElement(imageUrl: string): HTMLImageElement | undefined {
    const images = Array.from(document.images);
    return images.find((img) => img.currentSrc === imageUrl || img.src === imageUrl)
        ?? images.find((img) => {
            const src = img.currentSrc || img.src;
            if (!src || !imageUrl) return false;
            return src.startsWith(imageUrl) || imageUrl.startsWith(src);
        });
}

// 图片的显示区域: 完全移出视口时返回 undefined, 既不用播放动画也不必叠蓝点
function measureVisibleImage(image: HTMLImageElement | undefined): ScanRect | undefined {
    if (!image) return undefined;
    const box = image.getBoundingClientRect();
    const outside =
        box.bottom < 0 ||
        box.top > window.innerHeight ||
        box.right < 0 ||
        box.left > window.innerWidth;
    if (outside) return undefined;
    return measureImageRect(image);
}

// 网页图片处理流程
async function handleImageUrl(imageUrl: string) {
    const origin = window.location.origin;
    // 记录当前扫描轮次: 用户改用截图扫描后, 本次图片扫描的后续通知全部丢弃
    const epoch = screenshotEpoch;
    const isStale = () => epoch !== screenshotEpoch;

    const outcome = await decodeAndNotify(
        () => loadImageDataFromUrl(imageUrl, {
            origin,
            // 同源地址也可能 302 到 CDN 导致 canvas 被污染, 代理始终备好用于自动兜底
            fetchViaProxy: fetchImageViaProxy,
        }),
        {
            isStale,
            errorTitle: t('imageFetchFailed'),
            onRetry: () => void handleScreenshot(),
            // 网页图片需要先下载/取像素: 取图期间提示"正在获取图片"
            notifyFetching,
            // 图片取到、扫描提示出现后, 再在网页上的图片区域播放扫描动画
            beforeNotice: async () => {
                const rect = measureVisibleImage(findImageElement(imageUrl));
                if (rect) await scanAnimation.play({ rect });
            },
            afterDecode: () => scanAnimation.stop(),
            // 结果通知与蓝点同时给出, 由这里统一处理
            deferResults: true,
        },
    );
    if (isStale()) return;

    if (outcome.status === 'ok') {
        // 码坐标按图片实际显示区域换算, 点蓝点即可切换到该码的结果
        const image = findImageElement(imageUrl);
        const rect = measureVisibleImage(image);
        if (rect && image) {
            await showResults(outcome, {
                rect,
                imageSize: outcome.imageSize,
                scroll: { x: window.scrollX, y: window.scrollY },
                viewportWidth: window.innerWidth,
                followScroll: true,
                // 图片查看器等浮层里的图片不随页面滚动, 只按滚动差量平移会把蓝框推偏,
                // 交一个重测函数让蓝框每次都以图片的实时位置为准
                measureRect: () => measureVisibleImage(image),
            });
        } else {
            await notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
        }
        return;
    }

    if (outcome.status === 'failed') {
        // 本地文件在部分浏览器中会因 canvas 安全限制无法读取像素,
        // 此时退回截取当前标签页(直接打开的图片会完整显示在视口中)
        if (imageUrl.startsWith('file:') && window.location.protocol === 'file:') {
            try {
                const dataUrl = await captureVisibleTab();
                const fallback = await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl), {
                    isStale,
                    deferResults: true,
                });
                if (isStale() || fallback.status !== 'ok') return;
                await showResults(fallback, viewportAnchor(fallback.imageSize));
                return;
            } catch {
                // 截图也失败时保留最初的错误提示
            }
        }
    }
}

// 截图扫描每轮开始都会递增, 用于判断图片扫描的结果是否已过期
let screenshotEpoch = 0;
// 当前留在页面上的截图浮层: 新一轮截图先收起它, 避免多张截图叠在一起
let activeShot: ScreenshotSession | null = null;
clearActiveMarks = () => {
    clearMarks();
    activeShot?.clearResults();
};

// 截图流程的失败提示: 用户取消是静默的, 其余情况提示失败原因
function notifyScreenshotError(error: unknown) {
    if (isScreenshotResult(error) && error.type === 'cancelled') return;
    const message = error instanceof Error ? error.message : '';
    void notify(
        message
            ? errorNotice(t('screenshotFailed'), message)
            : warningNotice(t('screenshotFailed'), t('screenshotFailedMsg')),
    );
}

function isScreenshotResult(error: unknown): error is ScreenshotResult {
    return (
        typeof error === 'object' &&
        error !== null &&
        'type' in error &&
        (error.type === 'failed' || error.type === 'cancelled')
    );
}

async function handleScreenshot() {
    screenshotEpoch++;
    clearMarks();
    void scanAnimation.stop();
    const epoch = screenshotEpoch;
    // 点蓝点时用的结果: 每扫完一次就替换
    let results: DecodeResult[] = [];
    // 框选轮次: 用户在结果画面上再框一块时, 前一轮的结果作废
    let captureSeq = 0;
    let shot: ScreenshotSession | null = null;

    // 每框选一次扫一次: 命中后蓝框留在截图上, 用户可接着框下一块
    async function scanCapture(capture: ScreenshotCapture) {
        if (!shot) return;
        const seq = ++captureSeq;
        results = [];
        const outcome = await decodeAndNotify(
            () => getImageDataFromDataUrl(capture.dataUrl),
            { isStale: () => epoch !== screenshotEpoch, deferResults: true },
        );
        // 整轮扫描已结束, 或这次框选被下一次框选取代: 不覆盖画面
        if (epoch !== screenshotEpoch || seq !== captureSeq) return;
        if (outcome.status !== 'ok') {
            shot.clearResults();
            return;
        }
        results = outcome.results;
        // 识别结束后只收起这次的选区高亮, 结果蓝框蓝点要继续留在冻结的截图上供点选;
        // 早先这里清掉整层结果, 多码点选就跟着消失了
        shot.showResults(toMarkRects(outcome.results, {
            rect: capture.rect,
            imageSize: outcome.imageSize,
            scroll: { x: 0, y: 0 },
            viewportWidth: capture.viewport.width,
            followScroll: false,
            clip: capture.rect,
        }));
        await notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
    }

    try {
        shot = await startScreenshot({
            onPick: (index) => {
                const result = results[index];
                if (result) void notifyResults([result]);
            },
            onCapture: (capture) => void scanCapture(capture),
            onError: () => void notifyScreenshotError({ type: 'failed' }),
        });
        activeShot = shot;
    } catch (error) {
        notifyScreenshotError(error);
    }
}

// 一键截屏扫描: 截取当前视口后直接扫描整张画面, 不进入框选交互
async function handleQuickScreenshot() {
    screenshotEpoch++;
    clearMarks();
    void scanAnimation.stop();
    const epoch = screenshotEpoch;
    try {
        // 截图尺寸就是视口尺寸, 视口锚点直接按当前视口给出
        const scroll = { x: window.scrollX, y: window.scrollY };
        const dataUrl = await captureVisibleTab();
        // 截图完成后才播放整屏动画, 动画不会被截进图片;
        // 动画在解码期间一直循环, 通知要等动画淡出后再弹出
        const outcome = await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl), {
            isStale: () => epoch !== screenshotEpoch,
            beforeNotice: () => scanAnimation.play(),
            afterDecode: () => scanAnimation.stop(),
            // 结果通知由这里自己发 (与蓝点同时给出)
            deferResults: true,
        });
        if (epoch !== screenshotEpoch || outcome.status !== 'ok') return;
        // 单码多码同一条路径: 结果通知与蓝点同时给出, 点哪个码就把通知切到哪个码
        await showResults(outcome, viewportAnchor(outcome.imageSize, scroll));
    } catch (error) {
        void scanAnimation.stop();
        if (epoch !== screenshotEpoch) return;
        notifyScreenshotError(error);
    }
}

// 拿到图像数据后统一交给 recognizeImage: 动画 → 提示 → 解码 → 结果/重试/错误
function decodeAndNotify(
    loadImageData: () => Promise<ImageData>,
    options: {
        isStale?: () => boolean;
        onRetry?: () => void;
        errorTitle?: string;
        beforeNotice?: () => Promise<void>;
        notifyFetching?: () => Promise<unknown>;
        afterDecode?: () => void;
        deferResults?: boolean;
    } = {},
) {
    return recognizeImage(loadImageData, {
        host,
        isStale: options.isStale,
        // 只有调用方确认"再截一次图"有意义时才传 onRetry (截图流程自己就不该再给截图入口)
        onRetry: options.onRetry,
        errorTitle: options.errorTitle,
        beforeNotice: options.beforeNotice,
        notifyFetching: options.notifyFetching,
        afterDecode: options.afterDecode,
        deferResults: options.deferResults,
    });
}

// 截取当前标签页可见区域 (后台调用可避免屏幕共享提示), 作为本地图片无法读取时的兜底
async function captureVisibleTab(): Promise<string> {
    const response = await sendMessage<{ dataUrl: string }>('captureVisibleTab');
    return response.dataUrl;
}

// 跨域图片获取流程，通过向背景脚本发送消息请求代理获取图片数据
async function fetchImageViaProxy(url: string): Promise<string> {
    const response = await sendMessage<{ dataUrl: string }>('fetchImage', { url });
    return response.dataUrl;
}
</script>

<template>
    <div class="qr-content-root">
        <NotifyHost />
        <ScanMarks :rects="marks" @pick="pickMark" />
    </div>
</template>
