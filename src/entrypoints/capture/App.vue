<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import { useImageScan } from '@/composables/useImageScan';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { t } from '@/services/i18n';
import { errorNotice } from '@/services/decodeResultNotice';
import { getScreenshotIntroEnabled } from '@/services/screenshotSettings';
import { takeStoredString } from '@/services/storage';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// direct=1: 后台已判定当前页无法注入内容脚本, 直接识别整张截图, 不展示框选界面
const directMode = new URLSearchParams(window.location.search).has('direct');


const { notify } = useNoticeFallback();
const scanAnimation = useScanAnimation();

// 解码流程与其它入口共用; 直出模式在解码前播放整屏扫描动画
const { scan } = useImageScan({
    errorTitle: t('screenshotFailed'),
    beforeNotice: directMode ? () => scanAnimation.play() : undefined,
    afterDecode: directMode ? () => scanAnimation.stop() : undefined,
});


// 截图数据; 确认框选后清空以卸载框选界面
const src = ref('');
// 入场动画开关, 由扩展图标右键菜单控制
const introEnabled = ref(false);

const takeStoredImage = () => takeStoredString(CAPTURE_IMAGE_KEY);

// 标签页由扩展创建, 通常可直接关闭; 不允许时通过后台 API 关闭
function closeTab() {
    window.close();
    void browser.tabs
        .getCurrent()
        .then((tab) => (tab?.id != null ? browser.tabs.remove(tab.id) : undefined))
        .catch(() => {
            // 标签页已关闭时忽略
        });
}

// 框选确认或直出识别: 清空截图卸载框选界面, 再交给统一识别流程
async function handleConfirm(dataUrl: string) {
    src.value = '';
    await scan(dataUrl);
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
        // 直出模式跳过框选, 直接识别整张截图
        if (directMode) {
            await handleConfirm(stored);
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
        v-if="src"
        :src="src"
        :intro="introEnabled"
        @confirm="handleConfirm"
        @cancel="closeTab"
        @error="notifyScreenshotError"
    />
    <NotifyHost />
</template>
