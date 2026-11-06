<script lang="ts" setup>
import { computed, ref } from 'vue';
import ImagePicker from '@/components/ImagePicker.vue';
import type { ScanRect } from '@/components/ScanAnimation.vue';
import { useImageScanPanel } from '@/composables/useImageScanPanel';
import { measureDecodedImage, measureElementBox, measureImageRect } from '@/services/imageRect';
import { t } from '@/services/i18n';
import type { PopupNoticePayload } from '@/services/popupNotice';

const props = defineProps<{
    busy: boolean;
    notify: (payload: PopupNoticePayload) => Promise<unknown>;
    runScan: (loader: () => Promise<ImageData>, errorTitle: string) => Promise<void>;
}>();

const emit = defineEmits<{ cleared: [] }>();

const root = ref<HTMLElement | null>(null);

const { previewUrl, handleFile, scan, clearImage } = useImageScanPanel({
    isBusy: () => props.busy,
    notify: props.notify,
    runScan: props.runScan,
});

const hint = computed(() => (previewUrl.value ? t('previewHint') : ''));

function previewImage(): HTMLImageElement | null {
    const element = root.value?.querySelector('.qr-picker-preview');
    return element instanceof HTMLImageElement ? element : null;
}

// 扫描动画贴合图片本身的绘制区域, 取图空态退回取景框
async function measure(): Promise<ScanRect | undefined> {
    const image = previewImage();
    if (image) return measureDecodedImage(image);
    return measureElementBox(root.value);
}

// 结果绿点压在预览图的绘制区域上
function measureResult(): ScanRect | undefined {
    const image = previewImage();
    return image ? measureImageRect(image) : measureElementBox(root.value);
}

function clear() {
    clearImage();
    emit('cleared');
}

defineExpose({ measure, measureResult });
</script>

<template>
    <div ref="root" class="qr-scan-stage">
        <ImagePicker :preview-url="previewUrl" :busy="busy" @file="handleFile" />
        <div class="qr-scan-stage-tools">
            <button
                v-if="previewUrl"
                class="qr-scan-tool"
                type="button"
                :title="t('clearImage')"
                :aria-label="t('clearImage')"
                :disabled="busy"
                @click="clear"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16" />
                    <path d="M9.6 7V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2V7" />
                    <path d="m6.6 7 .8 11.6a1.2 1.2 0 0 0 1.2 1.1h6.8a1.2 1.2 0 0 0 1.2-1.1L17.4 7" />
                    <path d="M10.6 10.8v5M13.4 10.8v5" />
                </svg>
            </button>
            <button
                class="qr-scan-tool qr-scan-tool--primary"
                type="button"
                :title="t('scanNow')"
                :aria-label="t('scanNow')"
                :disabled="!previewUrl || busy"
                @click="scan"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 9V6.6A2.6 2.6 0 0 1 6.6 4H9" />
                    <path d="M15 4h2.4A2.6 2.6 0 0 1 20 6.6V9" />
                    <path d="M20 15v2.4a2.6 2.6 0 0 1-2.6 2.6H15" />
                    <path d="M9 20H6.6A2.6 2.6 0 0 1 4 17.4V15" />
                    <path d="M4 12h16" />
                </svg>
            </button>
        </div>
        <p v-if="hint" class="qr-scan-stage-hint">{{ hint }}</p>
    </div>
</template>

<style scoped>
/* 取图区占满取景框, 内容居中; 虚线边框正好充当取景提示 */
:deep(.qr-picker) {
    height: 100%;
    justify-content: center;
}

:deep(.qr-picker-figure) {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
}

:deep(.qr-picker-preview) {
    height: 100%;
}
</style>
