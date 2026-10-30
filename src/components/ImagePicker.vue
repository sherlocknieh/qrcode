<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { getImageFileFromDataTransfer } from '@/services/clipboardImage';
import { useNotify } from '@/composables/useNotify';
import { t } from '@/services/i18n';

// 取图区: 页面内浮层与独立识别页共用同一套结构与样式,
// 只负责拿到图片 (粘贴 / 拖放 / 选择文件), 识别与结果展示交给调用方。
const props = withDefaults(
    defineProps<{
        // 选择后的预览图; 浮层取到图片即关闭, 不传
        previewUrl?: string;
        busy?: boolean;
        // page: 独立识别页的整页卡片; overlay: 页面内浮层
        variant?: 'page' | 'overlay';
    }>(),
    { previewUrl: '', busy: false, variant: 'page' },
);

const emit = defineEmits<{
    (event: 'file', blob: Blob): void;
    (event: 'close'): void;
}>();

const { fire } = useNotify();

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

// 拖放事件会冒泡到子元素, 用计数避免划过内部文字时高亮闪烁
let dragDepth = 0;

async function warn(title: string, text?: string) {
    await fire({ toast: true, icon: 'warning', title, text, showCloseButton: true });
}

function pickFile() {
    if (!props.busy) fileInput.value?.click();
}

function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // 清空后重复选择同一张图片也会再次触发 change
    input.value = '';
    if (file) emit('file', file);
}

function onDragenter(event: DragEvent) {
    event.preventDefault();
    dragDepth += 1;
    if (!props.busy) dragging.value = true;
}

function onDragover(event: DragEvent) {
    event.preventDefault();
    if (!props.busy) dragging.value = true;
}

function onDragleave(event: DragEvent) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging.value = false;
}

function onDrop(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    dragging.value = false;
    if (props.busy) return;

    const file = getImageFileFromDataTransfer(event.dataTransfer);
    if (file) {
        emit('file', file);
        return;
    }
    if (event.dataTransfer?.files.length) {
        void warn(t('notImageFile'), t('notImageFileMsg'));
    }
}

function onPaste(event: ClipboardEvent) {
    if (props.busy) return;
    const file = getImageFileFromDataTransfer(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    emit('file', file);
}

function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || props.variant !== 'overlay') return;
    event.preventDefault();
    event.stopPropagation();
    emit('close');
}

// 拖到页面空白处时阻止浏览器直接打开文件
function preventPageDrop(event: DragEvent) {
    event.preventDefault();
}

onMounted(() => {
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('dragover', preventPageDrop);
    window.addEventListener('drop', preventPageDrop);
});

onBeforeUnmount(() => {
    document.removeEventListener('paste', onPaste, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('dragover', preventPageDrop);
    window.removeEventListener('drop', preventPageDrop);
});
</script>

<template>
    <div
        class="qr-picker"
        :class="{
            'qr-picker--overlay': variant === 'overlay',
            'qr-picker--active': dragging,
            'qr-picker--busy': busy,
        }"
        role="button"
        tabindex="0"
        :aria-busy="busy"
        @click="pickFile"
        @keydown.enter.prevent="pickFile"
        @keydown.space.prevent="pickFile"
        @dragenter="onDragenter"
        @dragover="onDragover"
        @dragleave="onDragleave"
        @drop="onDrop"
    >
        <template v-if="previewUrl">
            <!-- 预览外层用块级容器限制高度: flex 子项的自动最小尺寸会让 max-height 失效 (Firefox) -->
            <div class="qr-picker-figure">
                <img class="qr-picker-preview" :src="previewUrl" :alt="t('scanImageTitle')" />
            </div>
            <p class="qr-picker-hint">{{ t('previewHint') }}</p>
        </template>
        <template v-else>
            <svg class="qr-picker-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-4.5-4.5L7 20" />
            </svg>
            <p class="qr-picker-title">{{ t('dropImageHint') }}</p>
            <p class="qr-picker-hint">{{ t('pasteImageHint') }}</p>
            <span class="qr-picker-button">{{ t('chooseImage') }}</span>
        </template>

        <input ref="fileInput" class="qr-picker-input" type="file" accept="image/*" @change="onFileChange" />
    </div>
</template>

<style scoped>
.qr-picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    box-sizing: border-box;
    /* 占满外层卡片, 避免被预览图撑开 */
    width: 100%;
    min-width: 0;
    padding: 32px 20px;
    border: 2px dashed #cbd5e1;
    border-radius: 12px;
    background: #f8fafc;
    cursor: pointer;
    /* 兜底: 预览图在部分浏览器 (Firefox) 仍可能撑出圆角 */
    overflow: hidden;
    transition: border-color 0.15s, background-color 0.15s;
}

.qr-picker:hover,
.qr-picker:focus-visible {
    border-color: #60a5fa;
    background: #eff6ff;
    outline: none;
}

.qr-picker--active {
    border-color: #2563eb;
    background: #dbeafe;
}

.qr-picker--busy {
    cursor: progress;
    opacity: 0.7;
}

/* 浮层里空间更小, 收紧留白 */
.qr-picker--overlay {
    padding: 24px 16px;
}

.qr-picker-icon {
    width: 44px;
    height: 44px;
    margin-bottom: 12px;
    fill: none;
    stroke: #3b82f6;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.qr-picker--overlay .qr-picker-icon {
    width: 36px;
    height: 36px;
    margin-bottom: 8px;
}

.qr-picker-figure {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    /* 固定高度: 不依赖图片固有尺寸,
       Firefox 下 flex 子项的自动最小尺寸不会再把预览撑出面板 */
    width: 100%;
    height: 240px;
    overflow: hidden;
    border-radius: 8px;
    background: #fff;
}

.qr-picker-preview {
    display: block;
    width: 100%;
    height: 100%;
    /* 完整显示图片, 多余空间留白, 绝不溢出 */
    object-fit: contain;
    object-position: center;
}

.qr-picker--overlay .qr-picker-figure {
    height: 200px;
}

.qr-picker-title {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    color: #334155;
}

.qr-picker-hint {
    margin: 6px 0 16px;
    font-size: 13px;
    color: #94a3b8;
    text-align: center;
}

.qr-picker--overlay .qr-picker-hint {
    margin: 4px 0 12px;
    font-size: 12px;
}

.qr-picker-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 132px;
    padding: 9px 18px;
    border-radius: 8px;
    background: #2cabff;
    color: #fff;
    font: inherit;
    font-size: 14px;
}

.qr-picker-input {
    display: none;
}
</style>
