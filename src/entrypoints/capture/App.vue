<script lang="ts" setup>
import { onBeforeUnmount, onMounted } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import {
    useScreenshotScan,
    type ScreenshotScanCapture,
    type ScreenshotScanContext,
} from '@/composables/useScreenshotScan';
import { isNoticeVisible } from '@/services/noticeVisibility';
import { t } from '@/services/i18n';
import { describeImageError, errorNotice } from '@/services/decodeResultNotice';
import { sendMessage } from '@/services/messaging';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage } from '@/services/recognize';
import { takeStoredString } from '@/services/storage';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// ?frame=1 由"框选扫描"打开: 同一张视口图不自动整屏扫, 直接交给用户框一块
const frameOnly = new URLSearchParams(location.search).get('frame') === '1';

// 关闭本页的时机: 多码点选时要等用户点完所有绿点, 由最后一条通知收尾;
// 还有绿点没点时关掉通知只回到截图上继续点
let closeOnNoticeDone = true;
// 通知里的"框选扫描"要留在这一页继续扫, 这条通知收尾不能把页面关掉
let keepOnNoticeDone = false;
const shouldCloseOnNotice = () => closeOnNoticeDone && !keepOnNoticeDone;
const noticeOptions = {
    closeOriginTab: shouldCloseOnNotice,
    onLocalNoticeDone: () => {
        if (shouldCloseOnNotice()) closeTab();
    },
};
const { host, notify, notifyPickedResults, notifyResults } = useNoticeFallback(noticeOptions);
const scanAnimation = useScanAnimation();

// 与内容脚本同一套截图扫描: 全屏扫描就是对整屏自动框选一次, 之后还能继续框选重扫
const screenshotScan = useScreenshotScan({
    decode: decodeCapture,
    notifyResults: (results) => notifyPickedResults(results),
    notifyPicked: (result) => notifyResults([result]),
    onError: () => void notifyScreenshotError(),
    onClose: () => closeTab(),
    onResultsChanged: ({ count, picked, ok, selectable }) => {
        // 单码结果的通知就是这次展示, 关掉即关页; 多码等最后一个绿点被点掉;
        // 没扫到码时: 可框选层留着继续框, 只读结果层没有框选入口, 关掉通知就关页
        keepOnNoticeDone = false;
        closeOnNoticeDone = ok ? (picked ? count === 0 : count === 1) : !selectable;
    },
    onBlank: async () => {
        // 通知还开着时这一下多半是去关通知, 留到下一次点击再收摊
        if (await isNoticeVisible()) return;
        closeTab();
    },
});

const takeStoredImage = () => takeStoredString(CAPTURE_IMAGE_KEY);

// 关闭本标签页: 交给后台先切回来源页面再关闭, 否则浏览器会落到相邻标签页
function closeTab() {
    void sendMessage('closeExtensionTab')
        .then(() => undefined)
        .catch(() => window.close());
}

// 截图读取失败: 没有可用图片或扫描失败, 提示一致
async function notifyScreenshotError(error?: unknown) {
    const message = error instanceof Error ? describeImageError(error) : '';
    await notify(errorNotice(t('screenshotFailed'), message || t('screenshotFailedMsg')));
}

// 扫描光带要压过截图容器 (它用的是最高层级)
const SCAN_OVER_SHOT_Z_INDEX = 2147483647;

function fullScreenCapture(dataUrl: string): ScreenshotScanCapture {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return { dataUrl, rect: { x: 0, y: 0, ...viewport }, viewport };
}

function decodeCapture(capture: ScreenshotScanCapture, context: ScreenshotScanContext) {
    return recognizeImage(() => getImageDataFromDataUrl(capture.dataUrl), {
        host,
        errorTitle: t('screenshotFailed'),
        isStale: context.isStale,
        beforeNotice: () => scanAnimation.play({
            rect: context.rect,
            zIndex: SCAN_OVER_SHOT_Z_INDEX,
        }),
        afterDecode: () => scanAnimation.stop(),
        // 只读结果层没扫到码时给出"框选扫描", 换成可框选的工具在同一张截图上继续扫
        noResultRetry: context.selectable ? undefined : 'frameScan',
        onRetry: context.selectable ? undefined : () => void switchToFrameScan(),
        deferResults: true,
    });
}

// 这次扫的视口图: 换到框选工具时要复用同一张, 重新截屏只会截到本页自己
let shotSrc = '';

// 通知里点"框选扫描": 同一张截图切成可框选的一层, 不重新截屏
async function switchToFrameScan() {
    if (!shotSrc) return;
    keepOnNoticeDone = true;
    await screenshotScan.open({ src: shotSrc, selectable: true });
}

// 扩展页收不到内容脚本那套 tabs.sendMessage: 自己连一个端口,
// 让后台把通知里的"框选扫描"推回持有截图的那一页; 后台重启会断开端口, 断开后重连
function connectPagePort(): Browser.runtime.Port | undefined {
    try {
        const port = browser.runtime.connect({ name: 'extensionPage' });
        port.onMessage.addListener((message: { action?: string }) => {
            if (message?.action === 'frameScan') void switchToFrameScan();
        });
        port.onDisconnect.addListener(() => { pagePort = connectPagePort(); });
        return port;
    } catch {
        // 扩展正在卸载或页面已关闭: 不再重连
        return undefined;
    }
}

let pagePort = connectPagePort();

onMounted(async () => {
    document.title = t('appName');
    try {
        const stored = await takeStoredImage();
        if (!stored) {
            await notifyScreenshotError();
            return;
        }
        shotSrc = stored;
        // 截图交给截图容器承载: 扫描结果、绿点与后续框选都标在这张静止的截图上;
        // 框选入口只要可框选的一层, 整屏扫描则再自动扫一次整个画面
        await screenshotScan.open(frameOnly
            ? { src: stored, selectable: true }
            : { src: stored, autoCapture: fullScreenCapture(stored) });
    } catch (error) {
        await notifyScreenshotError(error);
    }
});

onBeforeUnmount(() => pagePort?.disconnect());
</script>

<template>
    <NotifyHost />
</template>
