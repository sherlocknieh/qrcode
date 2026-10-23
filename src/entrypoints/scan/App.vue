<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import { useNotify } from '@/composables/useNotify';
import {
    ClipboardImageError,
    blobToDataUrl,
    getImageFileFromDataTransfer,
    readClipboardImage,
} from '@/services/clipboardImage';
import { copyText } from '@/services/clipboard';
import { isLinkText, toOpenableUrl } from '@/services/linkText';
import {
    decodeAllFromImageData,
    getImageDataFromDataUrl,
    type DecodeResult,
} from '@/services/qrScanner';

const { fire, close, showLoading } = useNotify();

const t = (key: Parameters<typeof browser.i18n.getMessage>[0]) =>
    browser.i18n.getMessage(key) || String(key);

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const scanning = ref(false);
const previewUrl = ref('');

// popup 从该键读取待识别图片
const QR_IMAGE_KEY = 'qrImageUrl';

// 拖放事件会冒泡到子元素, 用计数避免鼠标划过内部文字时高亮闪烁
let dragDepth = 0;

function pickFile() {
    if (!scanning.value) fileInput.value?.click();
}

async function showWarning(title: string, text?: string) {
    await fire({
        toast: true,
        icon: 'warning',
        title,
        text,
        showCloseButton: true,
    });
}

async function showResult(result: DecodeResult) {
    const isLink = isLinkText(result.text);
    const copy = () => copyText(result.text);
    const response = await fire({
        toast: false,
        icon: 'success',
        title: t(result.kind === 'barcode' ? 'barcodeScanSuccess' : 'qrcodeScanSuccess'),
        text: result.text,
        showCancelButton: isLink,
        confirmButtonText: isLink ? t('openLink') : t('copyContent'),
        cancelButtonText: isLink ? t('copyLink') : undefined,
        showCloseButton: true,
        onConfirm: isLink ? undefined : copy,
        onCancel: isLink ? copy : undefined,
    });

    if (response.isConfirmed && isLink) {
        window.open(toOpenableUrl(result.text), '_blank');
    }
}

async function showResults(results: DecodeResult[]) {
    if (results.length === 1) {
        await showResult(results[0]!);
        return;
    }

    await fire({
        toast: false,
        icon: 'success',
        title: t('multiScanSuccess'),
        items: results,
        showCloseButton: true,
    });
}

async function scanInPage(dataUrl: string) {
    void fire({
        toast: true,
        icon: 'info',
        title: t('decodingQR'),
        didOpen: () => showLoading(),
        showCloseButton: true,
    });
    // 让加载提示先渲染再开始识别, 避免大图阻塞界面
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
        const imageData = await getImageDataFromDataUrl(dataUrl);
        const results = await decodeAllFromImageData(imageData);
        close();

        if (!results.length) {
            await fire({
                toast: false,
                icon: 'warning',
                title: t('recognitionFailed'),
                text: t('recognitionFailedMsg'),
                confirmButtonText: t('confirm'),
                showCloseButton: true,
            });
            return;
        }

        await showResults(results);
    } catch (error) {
        close();
        await fire({
            toast: false,
            icon: 'error',
            title: t('imageFetchFailed'),
            text: error instanceof Error ? error.message : String(error),
            confirmButtonText: t('confirm'),
            showCloseButton: true,
        });
    }
}

// 图片交给 popup 识别, 让加载和结果通知都显示在工具栏弹窗中
async function handOffToPopup(dataUrl: string): Promise<boolean> {
    const storage = browser.storage.session ?? browser.storage.local;
    try {
        await storage.set({ [QR_IMAGE_KEY]: dataUrl });
        const response = await browser.runtime.sendMessage({ action: 'openScanPopup' }) as
            | { success?: boolean }
            | undefined;
        if (response?.success) return true;
    } catch {
        // 存储或打开弹窗失败时回退到页内识别
    }
    await storage.remove(QR_IMAGE_KEY).catch(() => {});
    return false;
}

async function handleImage(blob: Blob) {
    if (scanning.value) return;

    scanning.value = true;
    try {
        const dataUrl = await blobToDataUrl(blob);
        previewUrl.value = dataUrl;

        if (await handOffToPopup(dataUrl)) return;
        // popup 无法显示时仍在当前页面完成识别
        await scanInPage(dataUrl);
    } catch (error) {
        await fire({
            toast: false,
            icon: 'error',
            title: t('imageFetchFailed'),
            text: error instanceof Error ? error.message : String(error),
            confirmButtonText: t('confirm'),
            showCloseButton: true,
        });
    } finally {
        scanning.value = false;
    }
}

function onFileChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // 清空后重复选择同一张图片也会再次触发 change
    input.value = '';
    if (file) void handleImage(file);
}

async function pasteFromClipboard() {
    if (scanning.value) return;

    let blob: Blob | null;
    try {
        blob = await readClipboardImage();
    } catch (error) {
        const unsupported = error instanceof ClipboardImageError && error.reason === 'unsupported';
        await showWarning(
            t('clipboardReadFailed'),
            t(unsupported ? 'clipboardUnsupportedMsg' : 'clipboardPermissionMsg'),
        );
        return;
    }

    if (!blob) {
        await showWarning(t('clipboardEmpty'), t('clipboardEmptyMsg'));
        return;
    }

    await handleImage(blob);
}

function onDragover(event: DragEvent) {
    event.preventDefault();
    if (!scanning.value) dragging.value = true;
}

function onDragleave(event: DragEvent) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragging.value = false;
}

function onDragenter(event: DragEvent) {
    event.preventDefault();
    dragDepth += 1;
    if (!scanning.value) dragging.value = true;
}

function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth = 0;
    dragging.value = false;

    const file = getImageFileFromDataTransfer(event.dataTransfer);
    if (file) {
        void handleImage(file);
        return;
    }
    if (event.dataTransfer?.files.length) {
        void showWarning(t('notImageFile'), t('notImageFileMsg'));
    }
}

function onPaste(event: ClipboardEvent) {
    const file = getImageFileFromDataTransfer(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    void handleImage(file);
}

// 拖到页面空白处时阻止浏览器直接打开文件
function preventDefaultDrop(event: DragEvent) {
    event.preventDefault();
    if (event.type === 'drop') {
        dragDepth = 0;
        dragging.value = false;
    }
}

onMounted(() => {
    document.title = t('appName');
    document.addEventListener('paste', onPaste);
    window.addEventListener('dragover', preventDefaultDrop);
    window.addEventListener('drop', preventDefaultDrop);
});

onBeforeUnmount(() => {
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('dragover', preventDefaultDrop);
    window.removeEventListener('drop', preventDefaultDrop);
});
</script>

<template>
    <main class="scan-page">
        <section class="scan-card">
            <header class="scan-header">
                <h1 class="scan-title">{{ t('scanImageTitle') }}</h1>
                <p class="scan-description">{{ t('scanImageDesc') }}</p>
            </header>


            <div
                class="scan-dropzone"
                :class="{
                    'scan-dropzone--active': dragging,
                    'scan-dropzone--busy': scanning,
                }"
                role="button"
                tabindex="0"
                :aria-busy="scanning"
                @click="pickFile"
                @keydown.enter.prevent="pickFile"
                @keydown.space.prevent="pickFile"
                @dragenter="onDragenter"
                @dragover="onDragover"
                @dragleave="onDragleave"
                @drop="onDrop"
            >
                <template v-if="previewUrl">
                    <img class="scan-preview" :src="previewUrl" :alt="t('scanImageTitle')" />
                    <p class="scan-dropzone-hint">{{ t('previewHint') }}</p>
                </template>
                <template v-else>
                    <svg class="scan-dropzone-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="m21 15-4.5-4.5L7 20" />
                    </svg>
                    <p class="scan-dropzone-title">{{ t('dropImageHint') }}</p>
                    <p class="scan-dropzone-hint">{{ t('pasteImageHint') }}</p>
                    <span class="scan-button scan-button--primary">{{ t('chooseImage') }}</span>
                </template>
            </div>

            <button
                type="button"
                class="scan-button scan-button--secondary"
                :disabled="scanning"
                @click="pasteFromClipboard"
            >
                {{ t('readClipboardImage') }}
            </button>

            <input
                ref="fileInput"
                class="scan-file-input"
                type="file"
                accept="image/*"
                @change="onFileChange"
            />
        </section>

        <NotifyHost />
    </main>
</template>

<style scoped>
.scan-page {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 32px 16px;
}

.scan-card {
    box-sizing: border-box;
    width: min(560px, 100%);
    padding: 28px;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
}

.scan-header {
    margin-bottom: 20px;
    text-align: center;
}

.scan-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: #0f172a;
}

.scan-description {
    margin: 8px 0 0;
    font-size: 14px;
    line-height: 1.6;
    color: #64748b;
}

.scan-dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 20px;
    border: 2px dashed #cbd5e1;
    border-radius: 12px;
    background: #f8fafc;
    cursor: pointer;
    transition: border-color 0.15s, background-color 0.15s;
}

.scan-dropzone:hover,
.scan-dropzone:focus-visible {
    border-color: #60a5fa;
    background: #eff6ff;
    outline: none;
}

.scan-dropzone--active {
    border-color: #2563eb;
    background: #dbeafe;
}

.scan-dropzone--busy {
    cursor: progress;
    opacity: 0.7;
}

.scan-dropzone-icon {
    width: 44px;
    height: 44px;
    margin-bottom: 12px;
    fill: none;
    stroke: #3b82f6;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.scan-preview {
    display: block;
    max-width: 100%;
    max-height: 320px;
    border-radius: 8px;
    object-fit: contain;
    background: #fff;
}

.scan-dropzone-title {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    color: #334155;
}

.scan-dropzone-hint {
    margin: 6px 0 16px;
    font-size: 13px;
    color: #94a3b8;
}

.scan-file-input {
    display: none;
}

.scan-button {
    display: inline-flex;
    box-sizing: border-box;
    align-items: center;
    justify-content: center;
    min-width: 132px;
    padding: 9px 18px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    color: #374151;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
}

.scan-button:hover:not(:disabled) {
    border-color: #9ca3af;
    background: #f9fafb;
}

.scan-button:disabled {
    cursor: progress;
    opacity: 0.6;
}

.scan-button--primary {
    border-color: #2563eb;
    background: #2563eb;
    color: #fff;
}

.scan-button--primary:hover {
    border-color: #1d4ed8;
    background: #1d4ed8;
}

.scan-button--secondary {
    width: 100%;
    margin-top: 14px;
}
</style>
