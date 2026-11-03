<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
import { t } from '@/services/i18n';
import { copyText } from '@/services/clipboard';

// 二维码生成面板: 默认只显示二维码, 点正中央的箭头展开一个输入框
const props = withDefaults(
    defineProps<{
        modelValue?: string;
        collapsible?: boolean;
    }>(),
    { modelValue: '', collapsible: false },
);

const emit = defineEmits<{
    (event: 'update:modelValue', value: string): void;
}>();

const text = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value),
});

const { dataUrl, error } = useQrCode(text);

const inputRef = ref<HTMLInputElement>();
const expanded = ref(!props.collapsible);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

// 浏览器在 focus 的默认动作里会重设光标位置, 等一帧再全选
function selectOnFocus() {
    requestAnimationFrame(() => inputRef.value?.select());
}

// 火狐 popup 拖出边界会中断原生划选, 靠聚焦全选加一键复制代替
async function copyInputText() {
    if (!text.value) return;
    if (!(await copyText(text.value))) return;
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
        copied.value = false;
    }, 1500);
}

// 鼠标划过底部矩形条时切换: 收起时展开, 已展开时再次悬停收起; 键盘聚焦只负责展开
function toggleOnHover() {
    if (props.collapsible) expanded.value = !expanded.value;
}

function expandOnFocus() {
    if (props.collapsible) expanded.value = true;
}
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

            <button
                v-if="collapsible"
                class="qr-panel-toggle"
                type="button"
                :aria-expanded="expanded"
                :aria-label="expanded ? t('collapseEditor') : t('moreOptions')"
                :title="expanded ? t('collapseEditor') : t('moreOptions')"
                @mouseenter="toggleOnHover"
                @focus="expandOnFocus"
                @click="expanded = !expanded"
            >
                <svg
                    class="qr-panel-toggle-icon"
                    :class="{ 'qr-panel-toggle-icon--up': expanded }"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                >
                    <path d="m4 6.5 4 4 4-4" />
                </svg>
            </button>
        </div>

        <div v-if="expanded" class="qr-panel-form">
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
            <button
                class="qr-panel-copy"
                type="button"
                :aria-label="copied ? t('copied') : t('copyInput')"
                :title="copied ? t('copied') : t('copyInput')"
                :disabled="!text"
                @mousedown.prevent
                @click="copyInputText"
            >
                <svg
                    v-if="copied"
                    class="qr-panel-copy-icon"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                >
                    <path d="m3.5 8.5 3 3 6-6.5" />
                </svg>
                <svg v-else class="qr-panel-copy-icon" viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="6" y="6" width="7.5" height="7.5" rx="1.5" />
                    <path d="M10 6V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v5A1.5 1.5 0 0 0 3.5 10H4" />
                </svg>
            </button>
        </div>
    </section>
</template>

<style scoped>
.qr-panel {
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

/* 展开的输入区自带底色, 与二维码留白互不影响 */
.qr-panel-form {
    position: relative;
    box-sizing: border-box;
    padding: 8px;
    background: #f8fafc;
    border-top: 1px solid #e2e8f0;
}

.qr-panel-input {
    box-sizing: border-box;
    width: 100%;
    /* 右侧留给内嵌的复制按钮 */
    padding: 4px 28px 4px 6px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: #1f2937;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    outline: none;
}

/* 复制入口内嵌在输入框右侧: 火狐 popup 里拖拽划选越过边界会中断 */
.qr-panel-copy {
    position: absolute;
    top: 50%;
    right: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    color: #64748b;
    background: none;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
    transform: translateY(-50%);
    transition: background-color 120ms ease, color 120ms ease;
}

.qr-panel-copy:hover:not(:disabled) {
    color: #1f2937;
    background: rgb(15 23 42 / 8%);
}

.qr-panel-copy:disabled {
    cursor: default;
    opacity: 0.35;
}

.qr-panel-copy:focus-visible {
    outline: 2px solid rgb(59 130 246 / 45%);
    outline-offset: -1px;
}

.qr-panel-copy-icon {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 聚焦不改变边框与背景, 没有任何高亮效果 */
.qr-panel-input:focus,
.qr-panel-input:focus-visible {
    border-color: #cbd5e1;
    box-shadow: none;
    outline: none;
}

/* 展开入口: 二维码底部白边上的矩形条, 平时不可见, 悬停才浮出箭头 */
.qr-panel-toggle {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 15px;
    padding: 0;
    color: #475569;
    background: none;
    border: 0;
    cursor: pointer;
    transition: background-color 120ms ease;
}

.qr-panel-toggle:hover,
.qr-panel-toggle:focus-visible {
    background: rgb(15 23 42 / 8%);
}

.qr-panel-toggle:focus-visible {
    outline: 2px solid rgb(59 130 246 / 45%);
    outline-offset: -1px;
}

.qr-panel-toggle-icon {
    width: 12px;
    height: 12px;
    /* 留一点可见性提示这里可以点, 悬停再完全显现 */
    opacity: 0.3;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: opacity 120ms ease, transform 150ms ease;
}

.qr-panel-toggle:hover .qr-panel-toggle-icon,
.qr-panel-toggle:focus-visible .qr-panel-toggle-icon {
    opacity: 1;
}

/* 展开后同一个箭头朝上, 表示可以收起 */
.qr-panel-toggle-icon--up {
    transform: rotate(180deg);
}
</style>
