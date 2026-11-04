<script lang="ts" setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
import { copyImageDataUrl } from '@/services/clipboardImage';
import { t } from '@/services/i18n';

// 二维码生成面板: 默认只显示二维码, 点二维码展开输入框
const props = withDefaults(
    defineProps<{
        modelValue?: string;
        collapsible?: boolean;
    }>(),
    { modelValue: '', collapsible: false },
);

const emit = defineEmits<{
    (event: 'update:modelValue', value: string): void;
    // 扫码入口只负责发出意图, 具体分发交给宿主 (popup 交给后台)
    (event: 'scan', entry: 'image' | 'screen' | 'camera'): void;
}>();

const text = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value),
});

const { dataUrl, error } = useQrCode(text);

const inputRef = ref<HTMLInputElement>();
const expanded = ref(!props.collapsible);

// 浏览器在 focus 的默认动作里会重设光标位置, 等一帧再全选
function selectOnFocus() {
    requestAnimationFrame(() => inputRef.value?.select());
}

// 二维码整块就是展开/收起入口, 没有再叠一个可见按钮
function toggleExpanded() {
    if (props.collapsible) expanded.value = !expanded.value;
}

// 悬停工具的复制按钮就地反馈结果: 成功换成对勾, 失败换回图标并短暂给出失败提示
const copyState = ref<'idle' | 'done' | 'failed'>('idle');
let copyTimer: number | undefined;

function setCopyState(state: 'done' | 'failed') {
    copyState.value = state;
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
        copyTimer = undefined;
        copyState.value = 'idle';
    }, 1500);
}

const copyLabel = computed(() => {
    if (copyState.value === 'done') return t('copied');
    if (copyState.value === 'failed') return t('screenshotCopyFailed');
    return t('qrCopy');
});

async function copyQrCode() {
    if (!dataUrl.value) return;
    setCopyState((await copyImageDataUrl(dataUrl.value)) ? 'done' : 'failed');
}

function downloadQrCode() {
    if (!dataUrl.value) return;
    const link = document.createElement('a');
    link.href = dataUrl.value;
    link.download = `${t('qrFileName')}.png`;
    link.click();
}

onBeforeUnmount(() => {
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
});
</script>

<template>
    <section class="qr-panel" :class="{ 'qr-panel--compact': !expanded }">
        <div class="qr-panel-preview">
            <img
                v-if="dataUrl"
                class="qr-panel-image"
                :src="dataUrl"
                :alt="text"
                :title="text"
            />
            <p v-else-if="error" class="qr-panel-error">{{ error }}</p>
            <p v-else class="qr-panel-hint">{{ t('qrEmptyHint') }}</p>

            <!-- 点击整块二维码展开/收起 -->
            <button
                v-if="collapsible"
                class="qr-panel-toggle"
                type="button"
                :aria-expanded="expanded"
                :aria-label="expanded ? t('collapseEditor') : t('moreOptions')"
                :title="expanded ? t('collapseEditor') : t('moreOptions')"
                @click="toggleExpanded"
            ></button>

            <!-- 悬停二维码时右下角浮出复制 / 下载 / 展开 -->
            <div v-if="dataUrl" class="qr-panel-tools">
                <button
                    class="qr-panel-tool qr-panel-tool--copy"
                    :class="{ 'qr-panel-tool--copied': copyState === 'done' }"
                    type="button"
                    :aria-label="copyLabel"
                    :title="copyLabel"
                    @click="copyQrCode"
                ></button>
                <button
                    class="qr-panel-tool qr-panel-tool--download"
                    type="button"
                    :aria-label="t('qrDownload')"
                    :title="t('qrDownload')"
                    @click="downloadQrCode"
                ></button>
                <button
                    v-if="collapsible"
                    class="qr-panel-tool"
                    :class="expanded ? 'qr-panel-tool--collapse' : 'qr-panel-tool--expand'"
                    type="button"
                    :aria-expanded="expanded"
                    :aria-label="expanded ? t('collapseEditor') : t('moreOptions')"
                    :title="expanded ? t('collapseEditor') : t('moreOptions')"
                    @click="toggleExpanded"
                ></button>
            </div>
        </div>

        <Transition name="qr-drawer">
            <div v-if="expanded" class="qr-panel-drawer">
                <div class="qr-panel-drawer-clip">
                    <div class="qr-panel-expanded">
                        <input
                            id="qr-panel-input"
                            ref="inputRef"
                            v-model="text"
                            class="qr-panel-input"
                            type="text"
                            spellcheck="false"
                            :placeholder="t('qrInputPlaceholder')"
                            @focus="selectOnFocus"
                        />

                        <div class="qr-panel-actions">
                            <button
                                class="qr-panel-action qr-panel-action--image"
                                type="button"
                                :aria-label="t('scanLocalImage')"
                                :title="t('scanLocalImage')"
                                @click="emit('scan', 'image')"
                            ></button>
                            <button
                                class="qr-panel-action qr-panel-action--screen"
                                type="button"
                                :aria-label="t('scanScreen')"
                                :title="t('scanScreen')"
                                @click="emit('scan', 'screen')"
                            ></button>
                            <button
                                class="qr-panel-action qr-panel-action--camera"
                                type="button"
                                :aria-label="t('cameraScanTitle')"
                                :title="t('cameraScanTitle')"
                                @click="emit('scan', 'camera')"
                            ></button>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </section>
</template>

<style scoped>
.qr-panel {
    /* 悬停工具的图标: 复制 / 下载 / 展开收起 / 复制成功 */
    --qr-copy: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5.5' y='5.5' width='8' height='8' rx='1.5'/%3E%3Cpath d='M10.5 3.5h-6A1.5 1.5 0 0 0 3 5v6'/%3E%3C/svg%3E");
    --qr-download: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 2.5v7'/%3E%3Cpath d='m5 6.5 3 3 3-3'/%3E%3Cpath d='M3 12.5h10'/%3E%3C/svg%3E");
    --qr-chevron-down: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E");
    --qr-chevron-up: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 10 4-4 4 4'/%3E%3C/svg%3E");
    --qr-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23fff' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 8.5 3 3 6-7'/%3E%3C/svg%3E");
    /* 扫码入口图标: 图片 / 屏幕 / 摄像头, 画成单色由 currentColor 上色 */
    --qr-scan-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='2.5' width='12' height='11' rx='1.5'/%3E%3Ccircle cx='5.5' cy='6' r='1'/%3E%3Cpath d='m2.5 11.5 3.2-3.2 2.4 2.4 2-2 3.4 3.4'/%3E%3C/svg%3E");
    --qr-scan-screen: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='1.5' y='2.5' width='13' height='9' rx='1.5'/%3E%3Cpath d='M8 11.5v2'/%3E%3Cpath d='M5.5 14h5'/%3E%3Cpath d='M4.5 7h7'/%3E%3C/svg%3E");
    --qr-scan-camera: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 4.5 7 3h2l1 1.5h2.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V6a1.5 1.5 0 0 1 1.5-1.5z'/%3E%3Ccircle cx='8' cy='9' r='2.4'/%3E%3C/svg%3E");
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    width: 220px;
    padding: 0;
}

.qr-panel-preview {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 220px;
    height: 220px;
    margin: 0 auto;
}

.qr-panel-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
}

.qr-panel-hint,
.qr-panel-error {
    margin: 0;
    padding: 0 12px;
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
}

.qr-panel-hint {
    color: #94a3b8;
}

.qr-panel-error {
    color: #dc2626;
}

/* 展开区像抽屉一样从二维码下方滑出: 用 grid 行高做 0fr → 1fr,
   不用写死高度, 输入框和扫码入口增减时动画仍然贴合内容 */
.qr-panel-drawer {
    display: grid;
    grid-template-rows: 1fr;
    transition: grid-template-rows 220ms ease;
}

.qr-panel-drawer-clip {
    min-height: 0;
    overflow: hidden;
}

.qr-drawer-enter-from,
.qr-drawer-leave-to {
    grid-template-rows: 0fr;
}

.qr-panel-expanded {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 8px 8px;
}

/* 展开后才出现扫描入口: 收起态只留二维码, 避免入口挤占预览 */
.qr-panel-actions {
    display: flex;
    gap: 8px;
}

.qr-panel-action {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding: 0;
    color: #475569;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
}

.qr-panel-action:hover {
    color: #0f172a;
    background: #e2e8f0;
}

.qr-panel-action:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: -1px;
}

.qr-panel-action::before {
    content: '';
    width: 16px;
    height: 16px;
    background: currentColor;
    -webkit-mask: var(--qr-action-icon) center / 16px 16px no-repeat;
    mask: var(--qr-action-icon) center / 16px 16px no-repeat;
}

.qr-panel-action--image {
    --qr-action-icon: var(--qr-scan-image);
}

.qr-panel-action--screen {
    --qr-action-icon: var(--qr-scan-screen);
}

.qr-panel-action--camera {
    --qr-action-icon: var(--qr-scan-camera);
}

.qr-panel-input {
    box-sizing: border-box;
    width: 100%;
    padding: 4px 6px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: #1f2937;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    outline: none;
}

/* 聚焦不改变边框与背景, 没有任何高亮效果 */
.qr-panel-input:focus,
.qr-panel-input:focus-visible {
    border-color: #cbd5e1;
    box-shadow: none;
    outline: none;
}

/* 展开入口: 整块二维码都是热区, 平时完全透明, 键盘聚焦时给出描边 */
.qr-panel-toggle {
    position: absolute;
    inset: 0;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
}

.qr-panel-toggle:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: -1px;
}

/* 悬停或键盘进入时右下角浮出工具条; 工具条本身不挡热区, 只有按钮可点 */
.qr-panel-tools {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: flex;
    gap: 4px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease;
}

.qr-panel-preview:hover .qr-panel-tools,
.qr-panel-preview:focus-within .qr-panel-tools {
    opacity: 1;
}

/* 只在工具条可见时接收点击, 避免不可见按钮挡住二维码热区 */
.qr-panel-preview:hover .qr-panel-tool,
.qr-panel-preview:focus-within .qr-panel-tool {
    pointer-events: auto;
}

.qr-panel-tool {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: #ffffff;
    pointer-events: none;
    background: rgba(15, 23, 42, 0.72);
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 120ms ease;
}

.qr-panel-tool:hover {
    background: rgba(15, 23, 42, 0.9);
}

.qr-panel-tool:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
}

.qr-panel-tool::before {
    content: '';
    width: 14px;
    height: 14px;
    background: currentColor;
    -webkit-mask: var(--qr-tool-icon) center / 14px 14px no-repeat;
    mask: var(--qr-tool-icon) center / 14px 14px no-repeat;
}

.qr-panel-tool--copy {
    --qr-tool-icon: var(--qr-copy);
}

.qr-panel-tool--copied {
    --qr-tool-icon: var(--qr-check);
}

.qr-panel-tool--download {
    --qr-tool-icon: var(--qr-download);
}

.qr-panel-tool--expand {
    --qr-tool-icon: var(--qr-chevron-down);
}

.qr-panel-tool--collapse {
    --qr-tool-icon: var(--qr-chevron-up);
}
</style>
