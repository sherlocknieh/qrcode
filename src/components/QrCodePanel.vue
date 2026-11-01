<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
import { t } from '@/services/i18n';

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

const expanded = ref(!props.collapsible);

// 鼠标划过底部矩形条或键盘聚焦时自动展开, 点击仍可用于收起
function expandOnHover() {
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
                @mouseenter="expandOnHover"
                @focus="expandOnHover"
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
                v-model="text"
                class="qr-panel-input"
                type="text"
                spellcheck="false"
                :placeholder="t('qrInputPlaceholder')"
            />
        </div>
    </section>
</template>

<style scoped>
.qr-panel {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
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
    box-sizing: border-box;
    padding: 8px;
    background: #f8fafc;
    border-top: 1px solid #e2e8f0;
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
