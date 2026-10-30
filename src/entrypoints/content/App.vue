<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

// 非UI组件
import {
    decodeAllFromImageData,
    getImageDataFromDataUrl,
    isSameOrigin,
    loadImageDataFromUrl,
    type DecodeResult,
} from '@/services/qrScanner';
import { isLinkText, toOpenableUrl } from '@/services/linkText';

// UI组件
import NotifyHost from '@/components/NotifyHost.vue';
import { useNotify, type NotifyOptions } from '@/composables/useNotify';
import { copyText } from '@/services/clipboard';
import { useScreenshot, type ScreenshotResult } from '@/composables/useScreenshot';
import { useQuickScanAnimation } from '@/composables/useQuickScanAnimation';
import { useImageScanAnimation, type ScanRect } from '@/composables/useImageScanAnimation';
import { preloadImageData } from '@/services/screenshotPreload';
import {
    showPopupNotice,
    type PopupNoticePayload,
} from '@/services/popupNotice';



const { fire, showLoading } = useNotify();
const { startScreenshot } = useScreenshot();
const quickScanAnimation = useQuickScanAnimation();
const imageScanAnimation = useImageScanAnimation();

// popup 无法显示时的页面内兜底通知
function fireLocal(payload: PopupNoticePayload, overrides: NotifyOptions = {}) {
    const { loading, ...options } = payload.options;
    return fire({
        ...options,
        ...overrides,
        didOpen: loading ? () => showLoading() : undefined,
    });
}

// 通知优先在 popup 中显示, 失败时回退到当前页面
async function notify(payload: PopupNoticePayload): Promise<boolean> {
    if (await showPopupNotice(payload)) return true;
    fireLocal(payload);
    return false;
}

// 识别结果需要用户选择, popup 可用时由 popup 直接完成打开/复制
async function notifyResult(result: DecodeResult) {
    const isLink = isLinkText(result.text);
    const payload: PopupNoticePayload = {
        options: {
            toast: false,
            icon: 'success',
            title: t(result.kind === 'barcode' ? 'barcodeScanSuccess' : 'qrcodeScanSuccess'),
            text: result.text,
            showCancelButton: isLink,
            confirmButtonText: isLink ? t('openLink') : t('copyContent'),
            cancelButtonText: isLink ? t('copyLink') : undefined,
            showCloseButton: true,
        },
        confirmAction: isLink
            ? { kind: 'open', value: result.text }
            : { kind: 'copy', value: result.text },
        cancelAction: isLink ? { kind: 'copy', value: result.text } : undefined,
    };

    if (await showPopupNotice(payload)) return;

    // popup 不可用时在页面内展示并处理结果
    const response = await fireLocal(payload, {
        // 复制按钮不关闭通知, 成功后按钮文字变为已复制, 期间仍可点击其他按钮
        onConfirm: payload.confirmAction?.kind === 'copy'
            ? () => copyText(result.text)
            : undefined,
        onCancel: payload.cancelAction?.kind === 'copy'
            ? () => copyText(result.text)
            : undefined,
    });

    if (isLink && response.isConfirmed) {
        window.open(toOpenableUrl(result.text), '_blank');
    }
}

// 国际化文本获取函数，提供默认值以防止缺失翻译导致的显示问题
const t = (key: Parameters<typeof browser.i18n.getMessage>[0]) =>
    browser.i18n.getMessage(key) || String(key);

// 批量识别结果: 只有一个码时沿用单码通知, 多个码时逐条列出
async function notifyResults(results: DecodeResult[]) {
    if (results.length === 1) {
        await notifyResult(results[0]!);
        return;
    }

    const payload: PopupNoticePayload = {
        options: {
            toast: false,
            icon: 'success',
            title: t('multiScanSuccess'),
            items: results,
            showCloseButton: true,
        },
    };

    if (await showPopupNotice(payload)) return;
    await fireLocal(payload);
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
    if (message.action === 'screenshotQRDirect') {
        handleQuickScreenshot();
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
    quickScanAnimation.stop();
    imageScanAnimation.cancel();
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
async function showDecodingNotice() {
    await notify({
        options: {
            toast: true,
            icon: 'info',
            title: t('decodingQR'),
            showCloseButton: true,
            loading: true,
        },
    });
    // 等待通知渲染后再做计算密集的识别, 避免界面卡顿
    await new Promise((resolve) => setTimeout(resolve, 50));
}

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

    try {
        const imageData = await loadImageDataFromUrl(imageUrl, {
            origin,
            fetchViaProxy: needsProxy ? fetchImageViaProxy : undefined,
        });
        if (isStale()) return;
        // 先用"正在识别"通知结束跨域加载提示, 再在图片区域播放扫描动画
        if (needsProxy) await showDecodingNotice();
        if (isStale()) return;
        const rect = findImageRect(imageUrl);
        if (rect) await imageScanAnimation.play(rect);
        if (isStale()) return;
        await decodeAndNotify(imageData, isStale, needsProxy);
    } catch (error) {
        if (isStale()) return;
        // 本地文件在部分浏览器中会因 canvas 安全限制无法读取像素，
        // 此时退回截取当前标签页(直接打开的图片会完整显示在视口中)。
        if (imageUrl.startsWith('file:') && window.location.protocol === 'file:') {
            try {
                const dataUrl = await captureVisibleTab();
                await decodeAndNotify(await getImageDataFromDataUrl(dataUrl), () => epoch !== screenshotEpoch);
                return;
            } catch {
                // 截图也失败时继续展示原始错误
            }
        }
        const message = error instanceof Error ? error.message : String(error);

        // 跨域图片常因防盗链无法获取, 此时建议并直接切换到截图识别
        if (needsProxy) {
            const payload: PopupNoticePayload = {
                options: {
                    toast: false,
                    icon: 'warning',
                    title: t('imageFetchFailed'),
                    text: `${message}\n${t('crossOriginScreenshotHint')}`,
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

        await notify({
            options: {
                toast: true,
                icon: 'error',
                title: t('imageFetchFailed'),
                text: message,
                showCloseButton: true,
            },
        });
    }
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
    imageScanAnimation.cancel();
    try {
        const dataUrl = await startScreenshot();
        const imageData = await getImageDataFromDataUrl(dataUrl);
        await decodeAndNotify(imageData);
    } catch (error) {
        notifyScreenshotError(error);
    }
}

// 一键截屏识别: 截取当前视口后直接识别整张画面, 不进入框选交互
async function handleQuickScreenshot() {
    screenshotEpoch++;
    imageScanAnimation.cancel();
    const epoch = screenshotEpoch;
    try {
        const dataUrl = await captureVisibleTab();
        // 截图完成后才开始播放动画, 动画不会被截进图片;
        // 读图与动画并行, 但通知要等动画播完再弹出
        const pending = preloadImageData(dataUrl);
        await quickScanAnimation.play();
        const settled = await pending;
        if (!settled.ok) throw settled.error;
        await decodeAndNotify(
            settled.imageData,
            () => epoch !== screenshotEpoch,
            false,
            () => quickScanAnimation.stop(),
        );
    } catch (error) {
        quickScanAnimation.stop();
        if (epoch !== screenshotEpoch) return;
        notifyScreenshotError(error);
    }
}

// 解码过程+通知流程; isStale 用于丢弃已被截图识别取代的过期结果, onDecoded 在解码结束时回调
async function decodeAndNotify(
    imageData: ImageData,
    isStale?: () => boolean,
    // 调用方已展示过"正在识别"通知时不再重复弹出
    noticeShown = false,
    onDecoded?: () => void,
) {
    if (isStale?.()) {
        onDecoded?.();
        return;
    }

    if (!noticeShown) await showDecodingNotice();

    // 默认识别图片中的所有码, 只有一个时仍按单码通知展示
    const results = await decodeAllFromImageData(imageData);
    onDecoded?.();
    if (isStale?.()) return;

    if (results.length) {
        // 文字结果没有可打开的链接, 只提供复制操作
        await notifyResults(results);
        return;
    }

    const payload: PopupNoticePayload = {
        options: {
            toast: false,
            icon: 'warning',
            title: t('recognitionFailed'),
            text: t('recognitionFailedMsg'),
            confirmButtonText: t('confirm'),
            extraButtonText: t('screenshotRetry'),
            showCloseButton: true,
        },
        extraAction: { kind: 'screenshot' },
    };

    if (await showPopupNotice(payload)) return;

    // popup 不可用时在页面内展示, 点击"尝试截图识别"直接开始区域截图
    const response = await fireLocal(payload);
    if (response.dismiss === 'extra') void handleScreenshot();
}

// 截取当前标签页可见区域，作为本地图片无法直接读取时的兜底
function captureVisibleTab(): Promise<string> {
    return new Promise((resolve, reject) => {
        browser.runtime.sendMessage({ action: 'captureVisibleTab' }, (response) => {
            if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError.message || 'Background did not respond.'));
                return;
            }
            if (response?.success && response.dataUrl) {
                resolve(response.dataUrl);
                return;
            }
            reject(new Error(response?.error || t('screenshotFailedMsg')));
        });
    });
}

// 跨域图片获取流程，通过向背景脚本发送消息请求代理获取图片数据
function fetchImageViaProxy(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        browser.runtime.sendMessage({ action: 'fetchImage', url }, (response) => {
            if (browser.runtime.lastError) {
                reject(new Error(browser.runtime.lastError.message || 'Background did not respond.'));
                return;
            }
            if (response?.success && response.dataUrl) {
                resolve(response.dataUrl);
                return;
            }
            reject(new Error(response?.error || t('proxyFetchFailed')));
        });
    });
}
</script>

<template>
    <div class="qr-content-root">
        <NotifyHost />
    </div>
</template>
