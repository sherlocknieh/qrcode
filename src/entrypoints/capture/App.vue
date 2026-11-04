<script lang="ts" setup>
import { nextTick, onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ScanMarks from '@/components/ScanMarks.vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { useCodePicker, type PickAnchor } from '@/composables/useCodePicker';
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
    if (outcome.status !== 'ok') return;
    picker.show(outcome.results, anchor(outcome.imageSize));
    await notifyResults(outcome.results, { pickHint: outcome.results.length > 1 });
}


// 后台截取的视口图; 扫描结束后仍保留在页面上, 标签页里原本没有其它内容
const src = ref('');
const stillRef = ref<HTMLImageElement | null>(null);
// 框选层是否可见: 确认后只卸载框选层, 截图继续铺在页面上
const showOverlay = ref(!directMode);
// 入场动画开关, 由扩展图标右键菜单控制
const introEnabled = ref(false);

const takeStoredImage = () => takeStoredString(CAPTURE_IMAGE_KEY);

// 关闭本标签页: 交给后台先切回来源页面再关闭, 否则浏览器会落到相邻标签页
function closeTab() {
    void sendMessage('closeExtensionTab')
        .then(() => undefined)
        .catch(() => window.close());
}

// 框选确认: 只卸载框选层, 保留截图作为页面内容, 再交给统一扫描流程。
// 选区与截图时的视口一起换算到页面上的截图区域, 扫描后才能标出码的位置
async function handleConfirm(payload: { dataUrl: string; rect: ScanRect; viewport: { width: number; height: number } }) {
    showOverlay.value = false;
    // 先让截图铺到页面上, 后面才能量出它的绘制区域
    await nextTick();
    await stillRef.value?.decode().catch(() => undefined);
    const imageSize = payload.viewport;
    await scan(payload.dataUrl, (decoded) => {
        // 截图以 object-fit contain 铺在页面上, 可能留边, 先量出实际绘制区域
        const drawn = (stillRef.value && measureImageRect(stillRef.value)) ?? {
            x: 0,
            y: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        const scaleX = imageSize.width > 0 ? drawn.width / imageSize.width : 1;
        const scaleY = imageSize.height > 0 ? drawn.height / imageSize.height : 1;
        // 裁剪图的锚点 = 选区在绘制区域中的那一块, 才能与解码坐标对齐;
        // 选区之外没有可点的地方, 同时用作裁剪范围
        const region = {
            x: drawn.x + payload.rect.x * scaleX,
            y: drawn.y + payload.rect.y * scaleY,
            width: payload.rect.width * scaleX,
            height: payload.rect.height * scaleY,
        };
        return {
            rect: region,
            imageSize: decoded,
            scroll: { x: window.scrollX, y: window.scrollY },
            viewportWidth: window.innerWidth,
            followScroll: false,
            clip: region,
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
        v-if="src && showOverlay"
        :src="src"
        :intro="introEnabled"
        @confirm="handleConfirm"
        @cancel="closeTab"
        @error="notifyScreenshotError"
    />
    <!-- 无框选层时 (直出模式 / 框选已确认) 把后台截取的视口图铺在页面上 -->
    <img
        v-else-if="src"
        ref="stillRef"
        class="qr-capture-still"
        :src="src"
        :alt="t('screenShot')"
    />
    <ScanMarks :rects="marks" @pick="pickMark" />
    <NotifyHost />
</template>
