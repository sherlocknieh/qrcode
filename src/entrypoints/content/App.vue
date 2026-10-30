<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

// 非UI组件
import {
    getImageDataFromDataUrl,
    isSameOrigin,
    loadImageDataFromUrl,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage } from '@/services/messaging';
import { recognizeImage } from '@/services/recognize';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';

import { useScreenshot, type ScreenshotResult } from '@/composables/useScreenshot';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useImagePasteOverlay } from '@/composables/useImagePasteOverlay';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import {
    showPopupNotice,
    type PopupNoticePayload,
} from '@/services/popupNotice';

const { startScreenshot } = useScreenshot();
const { fireLocal, notify, notifyDecoding, host } = useNoticeFallback();
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

// 跨域图片加载期间的提示，提供"新标签打开图片"和"改用截图识别"两个出口。
// 提示保持加载态, 由后续的"正在识别"通知替换, 因此不会留下空白窗口。
async function notifyCrossOriginLoading(imageUrl: string) {
    const payload: PopupNoticePayload = {
        options: {
            toast: false,
            icon: 'info',
            title: t('fetchingImage'),
            text: t('crossOriginNotice'),
            showCancelButton: true,
            cancelButtonText: t('openImage'),
            confirmButtonText: t('screenshotScan'),
            showCloseButton: true,
            loading: true,
        },
        cancelAction: { kind: 'open', value: imageUrl },
        confirmAction: { kind: 'screenshot' },
    };

    if (await showPopupNotice(payload)) return;

    // popup 不可用时在页面内展示并处理两个按钮
    const response = await fireLocal(payload);
    if (response.isConfirmed) {
        void handleScreenshot();
    } else if (response.dismiss === 'cancel') {
        window.open(imageUrl, '_blank');
    }
}

// 扫描动画开始前的"正在识别"提示: 它会替换掉跨域加载提示,
// 因此动画一定是在加载通知结束之后才开始
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
    const needsProxy = !isSameOrigin(imageUrl, origin);
    // 记录当前识别轮次: 用户改用截图识别后, 本次图片识别的后续通知全部丢弃
    const epoch = screenshotEpoch;
    // 跨域图片先展示加载提示, 图片数据就绪后由"正在识别"通知替换它
    const isStale = () => epoch !== screenshotEpoch;
    if (needsProxy) {
        void notifyCrossOriginLoading(imageUrl);
    }

    const outcome = await decodeAndNotify(
        () => loadImageDataFromUrl(imageUrl, {
            origin,
            fetchViaProxy: needsProxy ? fetchImageViaProxy : undefined,
        }),
        {
            isStale,
            errorTitle: t('imageFetchFailed'),
            onRetry: () => void handleScreenshot(),
            // 与右键识别一致: 先在网页上的图片区域播放扫描动画, 动画结束再提示
            beforeNotice: async () => {
                // 跨域图片先用"正在识别"通知替换加载提示, 再开始动画
                if (needsProxy) await notifyDecoding();
                const rect = findImageRect(imageUrl);
                if (rect) await scanAnimation.play({ rect });
            },
            afterDecode: () => scanAnimation.stop(),
        },
    );
    if (isStale()) return;

    if (outcome.status === 'failed' && needsProxy) {
        // 跨域图片常因防盗链无法获取, 建议并直接切换到截图识别
        const payload: PopupNoticePayload = {
            options: {
                toast: false,
                icon: 'warning',
                title: t('imageFetchFailed'),
                text: `${messageOf(outcome.error)}\n${t('crossOriginScreenshotHint')}`,
                confirmButtonText: t('screenshotScan'),
                showCloseButton: true,
            },
            confirmAction: { kind: 'screenshot' },
        };
        if (await showPopupNotice(payload)) return;
        const response = await fireLocal(payload);
        if (response.isConfirmed) await handleScreenshot();
        return;
    }

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

function messageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

// 截图识别流程
function notifyScreenshotResult(result: ScreenshotResult) {
    if (result.type === 'cancelled') {
        if (result.silent) {
            return;
        }
        void notify({
            options: {
                toast: true,
                icon: 'error',
                title: t('screenshotCancelled'),
                text: t('screenshotCancelledMsg'),
                showCloseButton: true,
            },
        });
        return;
    }

    if (result.type === 'failed') {
        void notify({
            options: {
                toast: true,
                icon: 'warning',
                title: t('screenshotFailed'),
                text: t('screenshotFailedMsg'),
                showCloseButton: true,
            },
        });
        return;
    }
}

function isScreenshotResult(error: unknown): error is ScreenshotResult {
    return (
        typeof error === 'object' &&
        error !== null &&
        'type' in error &&
        (
            error.type === 'failed' ||
            error.type === 'cancelled'
        )
    );
}

// 截图识别每轮开始都会递增, 用于判断图片识别的结果是否已过期
let screenshotEpoch = 0;

// 截图流程的失败提示: 用户取消时静默, 其余情况提示失败原因
function notifyScreenshotError(error: unknown) {
    if (isScreenshotResult(error)) {
        notifyScreenshotResult(error);
        return;
    }
    const message = error instanceof Error ? error.message : String(error);
    void notify({
        options: {
            toast: true,
            icon: 'error',
            title: t('screenshotFailed'),
            text: message || t('screenshotFailedMsg'),
            showCloseButton: true,
        },
    });
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
        errorTitle?: string;
        beforeNotice?: () => Promise<void>;
        afterDecode?: () => void;
    } = {},
) {
    return recognizeImage(loadImageData, {
        host,
        isStale: options.isStale,
        onRetry: options.onRetry ?? (() => void handleScreenshot()),
        errorTitle: options.errorTitle,
        beforeNotice: options.beforeNotice,
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
