<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { getImageFileFromDataTransfer } from '@/services/clipboardImage';
import { useNotify } from '@/composables/useNotify';
import { warningNotice } from '@/services/decodeResultNotice';
import { t } from '@/services/i18n';

// 取图区: 只负责拿到图片 (粘贴 / 拖放 / 选择文件)。
// 空态用"图标 + 主提示 + 格式说明 + 选择按钮"分层说明入口, 整块区域仍可点选;
// 选中后只显示预览图, 主提示、扫描与结果展示都交给 LocalScanPanel 统一处理。
const props = withDefaults(
    defineProps<{
        // 选择后的预览图
        previewUrl?: string;
        busy?: boolean;
    }>(),
    { previewUrl: '', busy: false },
);

const emit = defineEmits<{
    (event: 'file', blob: Blob): void;
}>();

const { fire } = useNotify();

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

// 拖放事件会冒泡到子元素, 用计数避免划过内部元素时高亮闪烁
let dragDepth = 0;

// 取图区的提示只发生在当前页面, 不需要走 popup 优先策略
async function warn(title: string, text?: string) {
    await fire(warningNotice(title, text).options);
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

// 拖到页面空白处时阻止浏览器直接打开文件
function preventPageDrop(event: DragEvent) {
    event.preventDefault();
}

onMounted(() => {
    document.addEventListener('paste', onPaste, true);
    window.addEventListener('dragover', preventPageDrop);
    window.addEventListener('drop', preventPageDrop);
});

onBeforeUnmount(() => {
    document.removeEventListener('paste', onPaste, true);
    window.removeEventListener('dragover', preventPageDrop);
    window.removeEventListener('drop', preventPageDrop);
});

// 标题栏的上传按钮复用同一个文件选择框
defineExpose({ pickFile });
</script>

<template>
    <!-- 整块区域可点选, 键盘入口交给内部的真实按钮, 避免出现嵌套的可交互元素 -->
    <div
        class="qr-picker"
        :class="{
            'qr-picker--active': dragging,
            'qr-picker--busy': busy,
        }"
        :aria-busy="busy"
        @click="pickFile"
        @dragenter="onDragenter"
        @dragover="onDragover"
        @dragleave="onDragleave"
        @drop="onDrop"
    >
        <!-- 预览态也用真实按钮承载, 键盘用户清空前仍能直接换图 -->
        <button
            v-if="previewUrl"
            class="qr-picker-figure"
            type="button"
            :disabled="busy"
            :aria-label="t('previewHint')"
            @click.stop="pickFile"
        >
            <img class="qr-picker-preview" :src="previewUrl" alt="" />
        </button>
        <template v-else>
            <span class="qr-picker-badge">
                <svg class="qr-picker-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-4.5-4.5L7 20" />
                </svg>
            </span>
            <p class="qr-picker-title">{{ t('pickerHint') }}</p>
        </template>

        <input ref="fileInput" class="qr-picker-input" type="file" accept="image/*" @change="onFileChange" />
    </div>
</template>

<style scoped>
.qr-picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    /* 占满取景框, 避免被预览图撑开 */
    width: 100%;
    height: 100%;
    min-width: 0;
    /* padding: 8px; */
    border: 0;
    border-radius: 10px;
    background: transparent;
    cursor: pointer;
    /* 兜底: 预览图在部分浏览器 (Firefox) 仍可能撑出圆角 */
    overflow: hidden;
    transition: border-color 150ms ease, background-color 150ms ease;
}

.qr-picker:hover {
    background: #f8fafc;
}

.qr-picker:focus-within {
    background: #f8fafc;
}

/* 拖入时用品牌蓝浅底提示可以松手, 虚线框由取景框同步变色 */
.qr-picker--active {
    border: 0;
    background: #eff6ff;
}

.qr-picker--busy {
    cursor: progress;
    opacity: 0.6;
}

/* 图标嵌在白色圆底上, 作为取图区的视觉锚点 */
.qr-picker-badge {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    /* 完整声明外边距与透明度, 避免页面全局规则把图标顶偏 */
    margin: 0;
    border: 1px solid #dbeafe;
    border-radius: 50%;
    background: linear-gradient(180deg, #ffffff 0%, #f2f7ff 100%);
    box-shadow: 0 0 0 6px rgba(37, 99, 235, 0.04);
    opacity: 1;
}

.qr-picker-icon {
    width: 26px;
    height: 26px;
    margin: 0;
    opacity: 1;
    fill: none;
    stroke: #2563eb;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 与摄像头空态的提示同一套字号与留白, 两种来源的空态看起来才对得上 */
.qr-picker-title {
    margin: 12px 0 0;
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.4;
    color: #334155;
    text-align: center;
}

.qr-picker-figure {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    /* 作为按钮使用时也不被页面全局样式改写外观 */
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    opacity: 1;
    cursor: pointer;
    overflow: hidden;
    border-radius: 10px;
}

.qr-picker-figure:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.45);
    outline-offset: -2px;
}

.qr-picker-preview {
    /* 火狐图片文档的样式给 img 设了 position: absolute + inset: 0 + margin: auto,
       预览图会被抽离文档流并铺满整个面板, 盖住标题与按钮。
       火狐按用户级样式注入内容脚本 CSS, 作者级的页面规则优先, 必须加 !important 才压得住 */
    position: static !important;
    inset: auto !important;
    margin: 0 !important;
    display: block;
    width: 100%;
    height: 100%;
    /* 完整显示图片, 多余空间留白, 绝不溢出 */
    object-fit: contain;
    object-position: center;
}

.qr-picker-input {
    display: none;
}
</style>
