<script lang="ts" setup>
import { onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import { useNotify } from '@/composables/useNotify';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { preloadImageData } from '@/services/screenshotPreload';
import { copyText } from '@/services/clipboard';
import { t } from '@/services/i18n';
import { resultNotice, runNoticeAction } from '@/services/decodeResultNotice';
import { takeStoredString } from '@/services/storage';
import {
    decodeAllFromImageData,
    getImageDataFromDataUrl,
    type DecodeResult,
} from '@/services/qrScanner';

// background 截取视口后写入该键, 本页面读取后立即清除
const CAPTURE_IMAGE_KEY = 'qrCaptureImage';

// direct=1: 后台已判定当前页无法注入内容脚本, 直接识别整张截图, 不展示框选界面
const directMode = new URLSearchParams(window.location.search).has('direct');


const { fire, close, showLoading } = useNotify();
const scanAnimation = useScanAnimation();


// 截图数据; 确认框选后清空以卸载框选界面
const src = ref('');

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

async function showError(title: string, text?: string) {
    await fire({
        toast: false,
        icon: 'error',
        title,
        text,
        confirmButtonText: t('confirm'),
        showCloseButton: true,
    });
}

async function showResult(results: DecodeResult[]) {
    const payload = resultNotice(results);
    // 复制成功后保留窗口, 通知由用户自行关闭
    let copied = false;
    const copy = (value: string) => async () => {
        if (await copyText(value)) copied = true;
        return copied;
    };
    const confirmCopy = payload.confirmAction?.kind === 'copy' ? payload.confirmAction.value : undefined;
    const cancelCopy = payload.cancelAction?.kind === 'copy' ? payload.cancelAction.value : undefined;

    const response = await fire({
        ...payload.options,
        onConfirm: confirmCopy ? copy(confirmCopy) : undefined,
        onCancel: cancelCopy ? copy(cancelCopy) : undefined,
    });

    if (response.isConfirmed) runNoticeAction(payload.confirmAction);

    if (!copied) closeTab();
}

async function showDecodingNotice() {
    void fire({
        toast: true,
        icon: 'info',
        title: t('decodingQR'),
        didOpen: () => showLoading(),
        showCloseButton: true,
    });
    // 等待通知渲染后再做计算密集的解码, 避免界面卡顿
    await new Promise((resolve) => setTimeout(resolve, 50));
}

async function handleConfirm(dataUrl: string) {
    src.value = '';

    // 直出模式没有框选界面: 先播放整屏扫描动画, 动画结束再弹出识别通知;
    // 读图与动画并行, 但通知一定要等动画播完
    let preloaded: ReturnType<typeof preloadImageData> | undefined;
    if (directMode) {
        preloaded = preloadImageData(dataUrl);
        await scanAnimation.play();
    }

    await showDecodingNotice();

    let results: DecodeResult[];
    try {
        let imageData: ImageData;
        if (preloaded) {
            const settled = await preloaded;
            if (!settled.ok) throw settled.error;
            imageData = settled.imageData;
        } else {
            imageData = await getImageDataFromDataUrl(dataUrl);
        }
        results = await decodeAllFromImageData(imageData);
    } catch (error) {
        scanAnimation.stop();
        close();
        await showError(
            t('screenshotFailed'),
            error instanceof Error ? error.message : String(error),
        );
        closeTab();
        return;
    }

    scanAnimation.stop();
    close();

    await showResult(results);
}

async function handleLoadError() {
    await showError(t('screenshotFailed'), t('screenshotFailedMsg'));
    closeTab();
}

onMounted(async () => {
    document.title = t('appName');
    try {
        const stored = await takeStoredImage();
        if (!stored) {
            await handleLoadError();
            return;
        }
        // 直出模式跳过框选, 直接识别整张截图
        if (directMode) {
            await handleConfirm(stored);
            return;
        }
        src.value = stored;
    } catch (error) {
        await showError(
            t('screenshotFailed'),
            error instanceof Error ? error.message : String(error),
        );
        closeTab();
    }
});
</script>

<template>
    <ScreenshotOverlay
        v-if="src"
        :src="src"
        @confirm="handleConfirm"
        @cancel="closeTab"
        @error="handleLoadError"
    />
    <NotifyHost />
</template>
