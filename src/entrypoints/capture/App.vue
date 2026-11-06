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
import { t } from '@/services/i18n';
import { describeImageError, errorNotice } from '@/services/decodeResultNotice';
import { sendMessage } from '@/services/messaging';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { isNoticeShowing } from '@/services/popupNotice';
import { recognizeImage, type RecognizeHost } from '@/services/recognize';
import { takeStoredString } from '@/services/storage';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// ?frame=1 由"框选扫描"打开: 同一张视口图不自动整屏扫, 直接交给用户框一块
const frameOnly = new URLSearchParams(location.search).get('frame') === '1';

// 关闭本页的时机: 有截图之后通知结束都不关页——扫完还能接着框选、点选,
// 由单击 / Esc 退出; "没图可看"的失败提示 (取图失败、图片读不出来) 与整页扫描的空结果
// 结束时收掉这一页
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
    onError: () => {
        // 图片读不出来就没有可框选的东西, 提示结束直接收掉这一页
        closeOnNoticeDone = true;
        void notifyScreenshotError();
    },
    onClose: () => closeTab(),
    // 多码还没点完时的单击 (没拖出选区): 通知还开着的话这一下是去消通知的, 不关页;
    // 通知消掉后再点空白才收起 (单结果由扫描层直接收起)
    onBlank: async () => {
        if (await isNoticeShowing()) return;
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

// 整页扫描没扫到: 这条通知收尾时连这一页一起收掉, 通知里点了「框选扫描」则不再关
const emptyNoticeHost: RecognizeHost = {
    ...host,
    notifyNoResult: (onRetry, retry) => {
        // 只有整屏扫描的无结果通知会带框选入口, 也是唯一"关掉即退出"的那种
        if (retry === 'frameScanOnly') closeOnNoticeDone = true;
        return host.notifyNoResult(onRetry, retry);
    },
};

function decodeCapture(capture: ScreenshotScanCapture, context: ScreenshotScanContext) {
    // 这一轮要么出结果要么重新框选: 先撤掉上一轮空结果留下的退出标记
    closeOnNoticeDone = false;
    return recognizeImage(() => getImageDataFromDataUrl(capture.dataUrl), {
        host: emptyNoticeHost,
        errorTitle: t('screenshotFailed'),
        isStale: context.isStale,
        beforeNotice: () => scanAnimation.play({
            rect: context.rect,
            zIndex: SCAN_OVER_SHOT_Z_INDEX,
            // 截图层已经整屏压暗, 动画不再自带遮罩, 否则两层叠起来发黑
            mask: false,
        }),
        afterDecode: () => scanAnimation.stop(),
        // 整页扫描没扫到: 通知里不留"确定", 只给框选入口; 关掉通知就关掉这一页,
        // 点了框选入口才退回纯框选态继续扫
        noResultRetry: context.fullScreen ? 'frameScanOnly' : undefined,
        // 通知在 popup 里时由 popup 转发框选请求, 页面内兜底通知就地退回框选态
        onRetry: context.fullScreen ? () => void switchToFrameScan() : undefined,
        deferResults: true,
    });
}

// 通知里点"尝试框选扫描": 现有截图层还在就退回纯框选态, 已被收起则用同一张图重开;
// 这条通知收尾时不能把页面关掉, 否则刚打开的框选层会跟着消失
async function switchToFrameScan() {
    closeOnNoticeDone = false;
    await screenshotScan.frameScan();
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
    // 标签页标题对应本次打开的功能: 框选扫描还是整屏扫描
    document.title = t(frameOnly ? 'frameScanScreenshot' : 'qrActionScreen');
    try {
        const stored = await takeStoredImage();
        if (!stored) {
            await notifyScreenshotError();
            return;
        }
        // 已经有可框选的截图了, 通知结束不再关页 (单击 / Esc 才退出)
        closeOnNoticeDone = false;
        // 截图交给截图容器承载: 扫描结果、绿点与后续框选都标在这张静止的截图上;
        // 框选入口只等用户框一块, 整屏扫描则先自动扫一次整个画面, 之后同样能接着框选
        await screenshotScan.open(frameOnly
            ? { src: stored }
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
