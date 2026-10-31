<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

// 非UI组件
import {
    getImageDataFromDataUrl,
    loadImageDataFromUrl,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage } from '@/services/messaging';
import { errorNotice, warningNotice } from '@/services/decodeResultNotice';
import { recognizeImage } from '@/services/recognize';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';

import { useScreenshot, type ScreenshotResult } from '@/composables/useScreenshot';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useImagePasteOverlay } from '@/composables/useImagePasteOverlay';
import type { ScanRect } from '@/components/ScanOverlay.vue';

const { startScreenshot } = useScreenshot();
const { notify, notifyFetching, host } = useNoticeFallback();
const scanAnimation = useScanAnimation();
const imagePasteOverlay = useImagePasteOverlay();

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
    if (message.action === 'screenshotQRDirect') {
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
    scanAnimation.stop();
    imagePasteOverlay.close();
});

// 找到右键识别的图片元素并返回其视口矩形; 背景图等找不到元素时返回 undefined
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
    // 记录当前识别轮次: 用户改用截图识别后, 本次图片识别的后续通知全部丢弃
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
            // 取图失败时仍可把原图丢到新标签页再识别
            openImageUrl: imageUrl,
            // 网页图片需要先下载/取像素: 取图期间提示"正在获取图片"
            notifyFetching,
            // 图片取到、识别提示出现后, 再在网页上的图片区域播放扫描动画
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

// 截图识别每轮开始都会递增, 用于判断图片识别的结果是否已过期
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
    scanAnimation.stop();
    try {
        const dataUrl = await startScreenshot();
        await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl));
    } catch (error) {
        notifyScreenshotError(error);
    }
}

// 一键截屏识别: 截取当前视口后直接识别整张画面, 不进入框选交互
async function handleQuickScreenshot() {
    screenshotEpoch++;
    scanAnimation.stop();
    const epoch = screenshotEpoch;
    try {
        const dataUrl = await captureVisibleTab();
        // 截图完成后才播放整屏动画, 动画不会被截进图片;
        // 读图与动画并行, 但通知要等动画播完再弹出
        await decodeAndNotify(() => getImageDataFromDataUrl(dataUrl), {
            isStale: () => epoch !== screenshotEpoch,
            beforeNotice: () => scanAnimation.play(),
            afterDecode: () => scanAnimation.stop(),
        });
    } catch (error) {
        scanAnimation.stop();
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
        openImageUrl?: string;
        errorTitle?: string;
        beforeNotice?: () => Promise<void>;
        notifyFetching?: () => Promise<unknown>;
        afterDecode?: () => void;
    } = {},
) {
    return recognizeImage(loadImageData, {
        host,
        isStale: options.isStale,
        // 只有调用方确认"再截一次图"有意义时才传 onRetry (截图流程自己就不该再给截图入口)
        onRetry: options.onRetry,
        openImageUrl: options.openImageUrl,
        errorTitle: options.errorTitle,
        beforeNotice: options.beforeNotice,
        notifyFetching: options.notifyFetching,
        afterDecode: options.afterDecode,
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
    </div>
</template>
