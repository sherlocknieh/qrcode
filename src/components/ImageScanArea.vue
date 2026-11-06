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
const picker = ref<InstanceType<typeof ImagePicker> | null>(null);

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

// 标题栏的上传按钮把点击转给取图区自己的文件选择框
function pickFile() {
    picker.value?.pickFile();
}

defineExpose({
    measure,
    measureResult,
    scan,
    // 标题栏的操作按钮由面板渲染, 这里交出状态与动作
    previewUrl,
    pickFile,
    clear,
});
</script>

<template>
    <div ref="root" class="qr-scan-stage">
        <ImagePicker ref="picker" :preview-url="previewUrl" :busy="busy" @file="handleFile" />
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
