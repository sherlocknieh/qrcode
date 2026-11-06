<script lang="ts" setup>
import { onMounted } from 'vue';

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

// 关闭本页的时机: 多码点选时要等用户点完所有绿点, 由最后一条通知收尾;
// 还有绿点没点时关掉通知只回到截图上继续点
let closeOnNoticeDone = true;
const noticeOptions = {
    closeOriginTab: () => closeOnNoticeDone,
    onLocalNoticeDone: () => {
        if (closeOnNoticeDone) closeTab();
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
        // 只读结果层没扫到也没有继续框选的入口, 关掉通知就关页
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
        deferResults: true,
    });
}

onMounted(async () => {
    document.title = t('appName');
    try {
        const stored = await takeStoredImage();
        if (!stored) {
            await notifyScreenshotError();
            return;
        }
        // 截图交给截图容器承载: 扫描结果、绿点与后续框选都标在这张静止的截图上
        await screenshotScan.open({ src: stored, autoCapture: fullScreenCapture(stored) });
    } catch (error) {
        await notifyScreenshotError(error);
    }
});
</script>

<template>
    <NotifyHost />
</template>
