<script lang="ts" setup>
import { nextTick, onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ScanMarks from '@/components/ScanMarks.vue';
import { useCodePicker, type PickAnchor } from '@/composables/useCodePicker';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { t } from '@/services/i18n';
import { errorNotice } from '@/services/decodeResultNotice';
import { sendMessage } from '@/services/messaging';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage } from '@/services/recognize';
import { measureImageRect } from '@/services/imageRect';
import { takeStoredString } from '@/services/storage';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// 通知结束后即视为本次扫描结束: 交给 popup 时由后台关闭标签页, 退回页面内时由本页自己关
const noticeOptions = {
    closeOriginTab: true,
    onLocalNoticeDone: () => closeTab(),
};
const { host, notify, notifyResults } = useNoticeFallback(noticeOptions);
const scanAnimation = useScanAnimation();
// 与内容脚本一致: 命中码后在画面上叠蓝点, 点哪个就把通知切到哪个码
const picker = useCodePicker({ notifyResults });
const marks = picker.marks;
const pickMark = picker.pick;

// 后台截取的视口图; 扫描结束后仍保留在页面上, 标签页里原本没有其它内容
const src = ref('');
const stillRef = ref<HTMLImageElement | null>(null);

const takeStoredImage = () => takeStoredString(CAPTURE_IMAGE_KEY);

// 关闭本标签页: 交给后台先切回来源页面再关闭, 否则浏览器会落到相邻标签页
function closeTab() {
    void sendMessage('closeExtensionTab')
        .then(() => undefined)
        .catch(() => window.close());
}

// 截图读取失败: 没有可用图片或扫描失败, 提示一致
async function notifyScreenshotError(error?: unknown) {
    const message = error instanceof Error ? error.message : '';
    await notify(errorNotice(t('screenshotFailed'), message || t('screenshotFailedMsg')));
}

// 视口图的锚点: 截图按实际绘制区域定位蓝框, 图片没量到尺寸时退回整个视口
function stillAnchor(imageSize: { width: number; height: number }): PickAnchor {
    return {
        rect: (stillRef.value && measureImageRect(stillRef.value)) ?? {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        },
        imageSize,
        scroll: { x: window.scrollX, y: window.scrollY },
        viewportWidth: window.innerWidth,
        followScroll: false,
    };
}

// 解码前播放整屏扫描动画, 结果通知与蓝点同时给出
async function scan(dataUrl: string) {
    const outcome = await recognizeImage(() => getImageDataFromDataUrl(dataUrl), {
        host,
        errorTitle: t('screenshotFailed'),
        beforeNotice: () => scanAnimation.play(),
        afterDecode: () => scanAnimation.stop(),
        deferResults: true,
    });
    if (outcome.status !== 'ok') return;
    picker.show(outcome.results, stillAnchor(outcome.imageSize));
    await notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
}

onMounted(async () => {
    document.title = t('appName');
    try {
        const stored = await takeStoredImage();
        if (!stored) {
            await notifyScreenshotError();
            return;
        }
        // 截图铺在页面上作为背景, 扫描结束后用户仍能看到原页面画面
        src.value = stored;
        // 等截图解码出尺寸, 才能量准绘制区域
        await nextTick();
        await stillRef.value?.decode().catch(() => undefined);
        await scan(stored);
    } catch (error) {
        await notifyScreenshotError(error);
    }
});
</script>

<template>
    <!-- 后台截取的视口图铺在页面上, 蓝框直接标在这张静止的画面上 -->
    <img
        v-if="src"
        ref="stillRef"
        class="qr-capture-still"
        :src="src"
        :alt="t('scanScreen')" />
    <ScanMarks :rects="marks" @pick="pickMark" />
    <NotifyHost />
</template>
