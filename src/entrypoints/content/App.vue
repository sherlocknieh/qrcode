<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

// 非UI组件
import { getImageDataFromDataUrl, loadImageDataFromUrl } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage } from '@/services/messaging';
import { describeImageError, errorNotice, warningNotice } from '@/services/decodeResultNotice';
import { recognizeImage, type DecodeOutcome, type RetryKind } from '@/services/recognize';
import { measureImageRect } from '@/services/imageRect';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';
import ScanResultMarks from '@/components/ScanResultMarks.vue';

import { useScanAnimation } from '@/composables/useScanAnimation';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useCodePicker, type PickAnchor } from '@/composables/useCodePicker';
import { useScreenshotScan, type ScreenshotScanCapture, type ScreenshotScanContext } from '@/composables/useScreenshotScan';
import type { ScreenshotResult } from '@/composables/useScreenshot';
import type { ScanRect } from '@/components/ScanAnimation.vue';

let clearActiveMarks = () => {};
const { notify, notifyFetching, notifyPickedResults, notifyResults, host } = useNoticeFallback({
    onLocalNoticeDone: () => onNoticeDone(),
});
const scanAnimation = useScanAnimation();

// 全屏扫描就是"对整屏自动框选一次": 与手动框选共用截图扫描流程
const screenshotScan = useScreenshotScan({
    decode: decodeScreenshotCapture,
    notifyResults: (results) => notifyPickedResults(results),
    notifyPicked: (result) => notifyResults([result]),
    onError: () => notifyScreenshotError({ type: 'failed' }),
    // 单击 (没拖出选区) 就是退出: 通知是否还开着都一样, 这一下点哪算哪;
    // 拖框选了一块则走 capture 继续扫, 不退出; 多码还没点完时浮层不发这个事件
    onBlank: () => screenshotScan.close(),
});

// 命中码后统一在画面上叠绿点: 网页图片按图片实时位置定位; 整屏扫描改用截图容器承载结果
// 点选产生的通知要单独标记: 关掉它只是看完其中一个码, 画面上还有码没点就继续留着
let pickedNotice = false;
const picker = useCodePicker({
    notifyResults: (results) => {
        pickedNotice = true;
        return notifyResults(results);
    },
});
const marks = picker.marks;
const marksAnchor = picker.anchorElement;
const pickedFlags = picker.pickedFlags;
const pickMark = picker.pick;
const clearMarks = picker.clear;

// 结果通知结束: 画面上还有多个码没点时, 这条通知要么只是多码提示, 要么只是看完了其中一个,
// 绿框都要留着继续点; 全点完才清网页图片上的标记。
// 截图浮层不跟通知走: 扫完之后还能接着拖框重扫, 单击才收起
function onNoticeDone() {
    const pending = picker.remaining.value;
    const keepOpen = pending > 1 || (pickedNotice && pending > 0);
    pickedNotice = false;
    if (keepOpen) return;
    clearActiveMarks();
}

// 码都在图标实际显示的区域里定位: 可定位的码叠绿点, 多条结果只留绿点, 点哪条出哪条的通知
function showResults(outcome: Extract<DecodeOutcome, { status: 'ok' }>, anchor: PickAnchor) {
    picker.show(outcome.results, anchor);
    return notifyPickedResults(outcome.results);
}

// 内容脚本的主流程函数，根据不同的消息类型调用相应的处理逻辑
const mainProcess = (
    message: { action?: string; imageUrl?: string },
    _sender: Browser.runtime.MessageSender,
    sendResponse: (response?: { success: boolean }) => void,
) => {
    if (message.action === 'notificationResolved') {
        onNoticeDone();
        sendResponse({ success: true });
        return false;
    }
    // 新一轮扫描开始: 作废进行中的结果并收起上一张冻结的截图
    if (message.action !== undefined) {
        screenshotEpoch++;
        pickedNotice = false;
        screenshotScan.close();
    }
    if (message.action === 'scanWebImage' && message.imageUrl) {
        handleImageUrl(message.imageUrl);
    }
    if (message.action === 'scanScreen') {
        handleScreenScan();
    }
    if (message.action === 'frameScan') {
        void openFrameScan();
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
    screenshotScan.close();
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

// 图片的显示区域: 完全移出视口时返回 undefined, 既不用播放动画也不必叠绿点
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
    // 记录当前扫描轮次: 用户改用框选扫描后, 本次图片扫描的后续通知全部丢弃
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
            // 图片读不出像素时改用框选扫描: 由用户框住页面上那张图, 比整屏再扫一遍更容易命中
            onRetry: () => void openFrameScan(),
            noResultRetry: 'frameScan',
            // 网页图片需要先下载/取像素: 取图期间提示"正在获取图片"
            notifyFetching,
            // 图片取到后, 在网页上的图片区域播放扫描动画
            beforeNotice: async () => {
                const image = findImageElement(imageUrl);
                const rect = measureVisibleImage(image);
                if (rect) await scanAnimation.play({ rect, anchor: image });
            },
            afterDecode: () => scanAnimation.stop(),
            // 结果通知与绿点同时给出, 由这里统一处理
            deferResults: true,
        },
    );
    if (isStale()) return;

    if (outcome.status === 'ok') {
        // 码坐标按图片实际显示区域换算, 点绿点即可切换到该码的结果
        const image = findImageElement(imageUrl);
        const rect = measureVisibleImage(image);
        if (rect && image) {
            await showResults(outcome, {
                rect,
                imageSize: outcome.imageSize,
                scroll: { x: window.scrollX, y: window.scrollY },
                viewportWidth: window.innerWidth,
                followScroll: true,
                // 图片查看器等浮层里的图片不随页面滚动, 只按滚动差量平移会把绿框推偏,
                // 交一个重测函数让绿框每次都以图片的实时位置为准
                measureRect: () => measureVisibleImage(image),
                element: image,
            });
        } else {
            await notifyResults(outcome.results);
        }
        return;
    }

    if (outcome.status === 'failed') {
        // 本地文件在部分浏览器中会因 canvas 安全限制无法读取像素,
        // 此时退回截取当前标签页(直接打开的图片会完整显示在视口中)
        if (imageUrl.startsWith('file:') && window.location.protocol === 'file:') {
            try {
                const dataUrl = await captureVisibleTab();
                if (isStale()) return;
                await scanAnimation.stop();
                // 直接转成截图扫描: 本地图片页的标记也标在静止的截图上, 不随滚动漂移
                await screenshotScan.open({ src: dataUrl, autoCapture: fullScreenCapture(dataUrl) });
                return;
            } catch {
                // 截图也失败时保留最初的错误提示
            }
        }
    }
}

// 每轮扫描开始都会递增, 用于判断上一轮的结果是否已过期
let screenshotEpoch = 0;
clearActiveMarks = clearMarks;

// 截图流程的失败提示: 用户取消是静默的, 其余情况提示失败原因
function notifyScreenshotError(error: unknown) {
    if (isScreenshotResult(error) && error.type === 'cancelled') return;
    const message = error instanceof Error ? describeImageError(error) : '';
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

// 截视口得到的整屏图: 作为"整屏框选"交给截图扫描
function fullScreenCapture(dataUrl: string): ScreenshotScanCapture {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return { dataUrl, rect: { x: 0, y: 0, ...viewport }, viewport };
}

// 扫描光带要压过截图容器 (它用的是最高层级)
const SCAN_OVER_SHOT_Z_INDEX = 2147483647;

// 截图扫描的解码: 在选区 (整屏扫描就是整个画面) 上播放扫描动画, 再解码
function decodeScreenshotCapture(
    capture: ScreenshotScanCapture,
    context: ScreenshotScanContext,
) {
    return decodeAndNotify(() => getImageDataFromDataUrl(capture.dataUrl), {
        isStale: context.isStale,
        beforeNotice: () => scanAnimation.play({
            rect: context.rect,
            zIndex: SCAN_OVER_SHOT_Z_INDEX,
            // 截图层已经整屏压暗, 动画不再自带遮罩, 否则两层叠起来发黑
            mask: false,
        }),
        afterDecode: () => scanAnimation.stop(),
        // 整页扫描没扫到: 通知里不留"确定", 只给框选入口; 退出与否看用户是单击还是拖框
        noResultRetry: context.fullScreen ? 'frameScanOnly' : undefined,
        onRetry: context.fullScreen ? () => void openFrameScan() : undefined,
        deferResults: true,
    });
}

// 框选扫描: 上一步整页扫描的截图还留着 (含已被收起的那张) 就直接退回框选态,
// 免得再截一次、把用户刚才看的画面换掉; 没有可用截图时才重新截一张
async function openFrameScan() {
    if (await screenshotScan.frameScan()) return;
    await screenshotScan.open();
}

// 扫描屏幕: 截取当前视口后直接进入截图扫描, 自动对整屏扫一次;
// 绿框标在静止的截图上, 页面滚动/缩放都不会让标记漂移
async function handleScreenScan() {
    screenshotEpoch++;
    clearMarks();
    // 等上一轮扫描动画退场, 否则新的 play() 会因为旧会话还在而直接跳过
    await scanAnimation.stop();
    const epoch = screenshotEpoch;
    try {
        const dataUrl = await captureVisibleTab();
        if (epoch !== screenshotEpoch) return;
        await screenshotScan.open({ src: dataUrl, autoCapture: fullScreenCapture(dataUrl) });
    } catch (error) {
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
        noResultRetry?: RetryKind;
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
        // 只有调用方确认"再试一次"有意义时才传 onRetry (截图流程自己就不该再给截图入口)
        onRetry: options.onRetry,
        noResultRetry: options.noResultRetry,
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
        <ScanResultMarks :rects="marks" :anchor="marksAnchor" :picked="pickedFlags" @pick="pickMark" @dismiss="clearMarks" />
    </div>
</template>
