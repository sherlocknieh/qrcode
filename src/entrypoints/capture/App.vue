<script lang="ts" setup>
import { nextTick, onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ScanMarks from '@/components/ScanMarks.vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { toMarkRects, useCodePicker, type PickAnchor } from '@/composables/useCodePicker';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { t } from '@/services/i18n';
import { errorNotice } from '@/services/decodeResultNotice';
import { sendMessage } from '@/services/messaging';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage } from '@/services/recognize';
import { measureImageRect } from '@/services/imageRect';
import { getScreenshotIntroEnabled } from '@/services/screenshotSettings';
import { takeStoredString } from '@/services/storage';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// direct=1: 后台已判定当前页无法注入内容脚本, 直接扫描整张截图, 不展示框选界面
const directMode = new URLSearchParams(window.location.search).has('direct');


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
const overlayRef = ref<InstanceType<typeof ScreenshotOverlay> | null>(null);

// 扫描流程与图片/摄像头面板共用同一个 recognizeImage; 直出模式在解码前播放整屏扫描动画
async function scan(dataUrl: string, anchor: (imageSize: { width: number; height: number }) => PickAnchor) {
    const outcome = await recognizeImage(() => getImageDataFromDataUrl(dataUrl), {
        host,
        errorTitle: t('screenshotFailed'),
        beforeNotice: directMode ? () => scanAnimation.play() : undefined,
        afterDecode: directMode ? () => scanAnimation.stop() : undefined,
        // 结果通知与蓝点同时给出, 由这里统一处理
        deferResults: true,
    });
    if (outcome.status !== 'ok') {
        if (!directMode) overlayRef.value?.clearResults();
        return;
    }
    const pickAnchor = anchor(outcome.imageSize);
    picker.show(outcome.results, pickAnchor);
    if (!directMode) {
        overlayRef.value?.showResults(toMarkRects(outcome.results, pickAnchor));
    }
    await notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
}


// 后台截取的视口图; 扫描结束后仍保留在页面上, 标签页里原本没有其它内容
const src = ref('');
const stillRef = ref<HTMLImageElement | null>(null);
// 入场动画开关, 由扩展图标右键菜单控制
const introEnabled = ref(false);

const takeStoredImage = () => takeStoredString(CAPTURE_IMAGE_KEY);

// 关闭本标签页: 交给后台先切回来源页面再关闭, 否则浏览器会落到相邻标签页
function closeTab() {
    void sendMessage('closeExtensionTab')
        .then(() => undefined)
        .catch(() => window.close());
}

// 框选确认: 冻结截图底图并保留框选层, 识别完成后可继续在同一张截图上框选。
// 选区本身就按浮层显示区域给出, 直接作为蓝框的锚点, 结果才能对准码的位置
async function handleConfirm(payload: { dataUrl: string; rect: ScanRect; viewport: { width: number; height: number } }) {
    await scan(payload.dataUrl, (decoded) => {
        return {
            rect: payload.rect,
            imageSize: decoded,
            scroll: { x: window.scrollX, y: window.scrollY },
            viewportWidth: window.innerWidth,
            followScroll: false,
            clip: payload.rect,
        };
    });
}

// 截图读取失败: 没有可用图片或框选层读图失败, 提示一致
async function notifyScreenshotError(error?: unknown) {
    const message = error instanceof Error ? error.message : '';
    await notify(errorNotice(t('screenshotFailed'), message || t('screenshotFailedMsg')));
}

onMounted(async () => {
    document.title = t('appName');
    try {
        const [stored, intro] = await Promise.all([
            takeStoredImage(),
            getScreenshotIntroEnabled().catch(() => false),
        ]);
        introEnabled.value = intro;
        if (!stored) {
            await notifyScreenshotError();
            return;
        }
        // 直出模式跳过框选, 直接扫描整张截图;
        // 截图保留在页面上作为背景, 扫描结束后用户仍能看到原页面画面
        if (directMode) {
            src.value = stored;
            // 等截图解码出尺寸, 才能量准绘制区域
            await nextTick();
            await stillRef.value?.decode().catch(() => undefined);
            await scan(stored, (decoded) => ({
                rect: (stillRef.value && measureImageRect(stillRef.value)) ?? {
                    x: 0,
                    y: 0,
                    width: window.innerWidth,
                    height: window.innerHeight,
                },
                imageSize: decoded,
                scroll: { x: window.scrollX, y: window.scrollY },
                viewportWidth: window.innerWidth,
                followScroll: false,
            }));
            return;
        }
        src.value = stored;
    } catch (error) {
        await notifyScreenshotError(error);
    }
});
</script>

<template>
    <ScreenshotOverlay
        v-if="src && !directMode"
        ref="overlayRef"
        :src="src"
        :intro="introEnabled"
        @confirm="handleConfirm"
        @pick="pickMark"
        @cancel="closeTab"
        @error="notifyScreenshotError"
    />
    <!-- 直出模式没有框选层: 把后台截取的视口图铺在页面上作为背景 -->
    <img
        v-else-if="src"
        ref="stillRef"
        class="qr-capture-still"
        :src="src"
        :alt="t('screenShot')"
    />
    <ScanMarks v-if="directMode" :rects="marks" @pick="pickMark" />
    <NotifyHost />
</template>
