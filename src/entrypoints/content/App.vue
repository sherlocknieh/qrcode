<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

// 非UI组件
import {
    getImageDataFromDataUrl,
    loadImageDataFromUrl,
    type DecodeResult,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage } from '@/services/messaging';
import { errorNotice, warningNotice } from '@/services/decodeResultNotice';
import { recognizeImage } from '@/services/recognize';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';
import ScanMarks from '@/components/ScanMarks.vue';

import { useScreenshot, type ScreenshotResult } from '@/composables/useScreenshot';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useImagePasteOverlay } from '@/composables/useImagePasteOverlay';
import type { ScanRect } from '@/components/ScanOverlay.vue';

const { startScreenshot } = useScreenshot();
const { notify, notifyFetching, notifyResults, host } = useNoticeFallback();
const scanAnimation = useScanAnimation();
const imagePasteOverlay = useImagePasteOverlay();

// 框来自截图, 记录截图时的滚动位置, 页面滚动后按差量把框挪回去 (见 marks)
type MarksSource = {
    results: DecodeResult[];
    // bounds 是截图图像的像素坐标, 这里存换算成 CSS 像素的比例
    scale: { x: number; y: number };
    scroll: { x: number; y: number };
    // 截图时的视口宽度: 只有宽度变化才会让页面重新排版, 才需要收起标记
    viewportWidth: number;
};
const marksSource = ref<MarksSource | null>(null);
// 页面滚动后框要跟着码走, 滚动位置用响应式保存下来触发重算
const scrollPos = ref({ x: window.scrollX, y: window.scrollY });
const marks = computed<ScanRect[]>(() => {
    const source = marksSource.value;
    if (!source) return [];
    // 框是固定定位的, 页面滚动多少就把框反向挪多少, 才跟得住码
    const shiftX = scrollPos.value.x - source.scroll.x;
    const shiftY = scrollPos.value.y - source.scroll.y;
    return source.results.map((result) => {
        const bounds = result.bounds!;
        return {
            x: bounds.x * source.scale.x - shiftX,
            y: bounds.y * source.scale.y - shiftY,
            width: bounds.width * source.scale.x,
            height: bounds.height * source.scale.y,
        };
    });
});

function syncScroll() {
    scrollPos.value = { x: window.scrollX, y: window.scrollY };
}

// 宽度变了页面会重新排版, 码的位置跟着变, 框没法再对准, 直接收起;
// 只改高度时横向排版没动, 框的位置仍然有效, 不必关闭
function onResize() {
    const source = marksSource.value;
    if (!source || window.innerWidth === source.viewportWidth) return;
    clearMarks();
}
const marksInteractive = computed(() => marksSource.value !== null);

function clearMarks() {
    marksSource.value = null;
}

// 码在画面上定位到就叠蓝点, 单码多码同一条路径: 由用户点蓝点决定看哪一个。
// 不设超时, 由用户点空白处收起 (ScanMarks 的 dismiss)
function showMarks(source: MarksSource) {
    clearMarks();
    if (!source.results.length) return;
    marksSource.value = source;
}

// 点中蓝点: 通知切到这个码的结果, 蓝点保留以便继续挑选
function pickMark(index: number) {
    const result = marksSource.value?.results[index];
    if (!result) return;
    void notifyResults([result]);
}

// 通知窗口是否还开着 (含刚被这次点击点掉的情况): 内容脚本发起的通知都落在 popup 里
async function isNoticeWindowOpen(): Promise<boolean> {
    try {
        const response = await sendMessage<{ open?: boolean }>('popupNoticeOpen');
        return response.open === true;
    } catch {
        return false;
    }
}

// 点击空白处收起蓝点。但通知窗口开着时, 这一下往往是去关 popup 的,
// 若此时收起, 用户就没法接着点码了, 所以留到下一次点击再收
async function dismissMarks() {
    if (await isNoticeWindowOpen()) return;
    clearMarks();
}

// 内容脚本的主流程函数，根据不同的消息类型调用相应的处理逻辑
const mainProcess = (
    message: { action?: string; imageUrl?: string },
    _sender: Browser.runtime.MessageSender,
    sendResponse: (response?: { success: boolean }) => void,
) => {
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
    // 页面滚动后框要跟着码走; scroll 不冒泡, 用捕获阶段接收内部滚动。
    // 窗口宽度变化会让页面重新排版, 由 onResize 决定收起
    window.addEventListener('scroll', syncScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
});

// 当组件卸载时，移除消息监听器，避免内存泄漏
onBeforeUnmount(() => {
    browser.runtime.onMessage.removeListener(mainProcess);
    window.removeEventListener('scroll', syncScroll, { capture: true });
    window.removeEventListener('resize', onResize);
    void scanAnimation.stop();
    clearMarks();
    imagePasteOverlay.close();
});

// 找到右键扫描的图片元素并返回其视口矩形; 背景图等找不到元素时返回 undefined
function findImageRect(imageUrl: string): ScanRect | undefined {
    const images = Array.from(document.images);
    const match = images.find((img) => img.currentSrc === imageUrl || img.src === imageUrl)
        ?? images.find((img) => {
            const src = img.currentSrc || img.src;
            if (!src || !imageUrl) return false;
            return src.startsWith(imageUrl) || imageUrl.startsWith(src);
        });
    if (!match) return undefined;

    const rect = match.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return undefined;
    // 图片完全移出视口时没必要播放动画
    const outside =
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth;
    if (outside) return undefined;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
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
                const rect = findImageRect(imageUrl);
                if (rect) await scanAnimation.play({ rect });
            },
            afterDecode: () => scanAnimation.stop(),
        },
    );
    if (isStale()) return;

    if (outcome.status === 'failed') {
        // 本地文件在部分浏览器中会因 canvas 安全限制无法读取像素,
        // 此时退回截取当前标签页(直接打开的图片会完整显示在视口中)
        if (imageUrl.startsWith('file:') && window.location.protocol === 'file:') {
            try {
                const dataUrl = await captureVisibleTab();
                await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl), { isStale });
                return;
            } catch {
                // 截图也失败时保留最初的错误提示
            }
        }
    }
}

// 截图扫描每轮开始都会递增, 用于判断图片扫描的结果是否已过期
let screenshotEpoch = 0;

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
    try {
        const dataUrl = await startScreenshot();
        await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl));
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
        // 记下截图那一刻的视口与滚动位置: 之后用户滚动页面时按差量跟随内容,
        // 宽度变化则说明页面重新排版了, 由 onResize 收起标记
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
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

        const located = outcome.results.filter((result) => result.bounds);
        const source: MarksSource = {
            results: located,
            // 截图按设备像素比放大, 用图像尺寸与截图时的视口尺寸换算回 CSS 像素
            scale: {
                x: outcome.imageSize.width > 0 ? viewportWidth / outcome.imageSize.width : 1,
                y: outcome.imageSize.height > 0 ? viewportHeight / outcome.imageSize.height : 1,
            },
            scroll,
            viewportWidth,
        };
        // 码都能在画面上定位时统一走蓝点, 单码也不特殊处理:
        // 结果通知与蓝点同时给出, 点哪个码就把通知切到哪个码, 可连续挑选
        if (located.length && located.length === outcome.results.length) {
            showMarks(source);
            if (epoch !== screenshotEpoch) return;
            await notifyResults(outcome.results, { pickHint: located.length > 1 });
            return;
        }
        // 有码但定位不全时没法叠蓝点, 直接给结果列表
        await notifyResults(outcome.results);
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
        <ScanMarks
            :rects="marks"
            :interactive="marksInteractive"
            @pick="pickMark"
            @dismiss="dismissMarks"
        />
    </div>
</template>
