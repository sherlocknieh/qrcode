<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
import { t } from '@/services/i18n';

// 二维码生成面板: popup 与独立生成页共用.
// collapsible 时默认只显示二维码, 输入区靠角落的小按钮展开, 保持默认界面极简
const props = withDefaults(
    defineProps<{
        modelValue?: string;
        variant?: 'popup' | 'page';
        collapsible?: boolean;
        expandable?: boolean;
    }>(),
    { modelValue: '', variant: 'popup', collapsible: false, expandable: false },
);

const emit = defineEmits<{
    (event: 'update:modelValue', value: string): void;
    (event: 'expand', value: string): void;
}>();

const text = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value),
});

const { dataUrl, error } = useQrCode(text);

const expanded = ref(!props.collapsible);
</script>

<template>
    <section
        class="qr-panel"
        :class="[`qr-panel--${variant}`, { 'qr-panel--compact': !expanded }]"
    >
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
            <label class="qr-panel-label" for="qr-panel-input">{{ t('qrInputLabel') }}</label>
            <textarea
                id="qr-panel-input"
                v-model="text"
                class="qr-panel-input"
                rows="3"
                spellcheck="false"
                :placeholder="t('qrInputPlaceholder')"
            ></textarea>

            <div class="qr-panel-actions">
                <select class="qr-panel-format" :aria-label="t('qrFormatLabel')">
                    <option value="qrcode">{{ t('qrFormatQrcode') }}</option>
                </select>
                <button
                    v-if="expandable"
                    class="qr-panel-expand"
                    type="button"
                    @click="emit('expand', text)"
                >{{ t('openInNewTab') }}</button>
            </div>
        </div>

    </section>
</template>

<style scoped>
.qr-panel {
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
}

/* popup 的尺寸在收起/展开时完全一致: 二维码始终 220x220 且贴边,
   输入区自己带卡片外观, 不影响二维码周围的留白 */
.qr-panel--popup {
    width: 220px;
    gap: 0;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 0;
}

.qr-panel--page {
    flex-direction: row;
    align-items: flex-start;
    gap: 24px;
    width: min(760px, calc(100vw - 32px));
    padding: 24px;
}

.qr-panel-preview {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 220px;
    height: 220px;
    margin: 0 auto;
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
}

/* popup 里二维码 PNG 自带白底与静默区, 不必再套一层白卡片 */
.qr-panel--popup .qr-panel-preview {
    flex: none;
    width: 220px;
    height: 220px;
    background: none;
    border: 0;
    border-radius: 0;
}

.qr-panel--page .qr-panel-preview {
    flex: none;
    width: 280px;
    height: 280px;
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

.qr-panel-form {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

/* 展开的输入区独立成卡片, 与二维码留白互不影响 */
.qr-panel--popup .qr-panel-form {
    box-sizing: border-box;
    padding: 12px;
    background: #f8fafc;
    border-top: 1px solid #e2e8f0;
}

.qr-panel-label {
    font-size: 12px;
    color: #64748b;
}

.qr-panel-input {
    box-sizing: border-box;
    width: 100%;
    min-height: 68px;
    padding: 8px 10px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: #1f2937;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    outline: none;
    resize: vertical;
}

.qr-panel--page .qr-panel-input {
    min-height: 160px;
    font-size: 14px;
}

.qr-panel-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgb(59 130 246 / 20%);
}

.qr-panel-actions {
    display: flex;
    align-items: center;
    gap: 8px;
}

.qr-panel-format,
.qr-panel-expand {
    box-sizing: border-box;
    padding: 5px 8px;
    font: inherit;
    font-size: 12px;
    color: #334155;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    cursor: pointer;
}

.qr-panel-expand {
    margin-left: auto;
}

.qr-panel-expand:hover {
    border-color: #3b82f6;
    color: #1d4ed8;
}

/* 编辑入口: 白色半透明圆形衬底, 浮在二维码正中央 */
.qr-panel-toggle {
    position: absolute;
    inset: 0;
    margin: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: #475569;
    background: rgb(255 255 255 / 78%);
    border: 0;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgb(15 23 42 / 14%);
    cursor: pointer;
    transition: background-color 120ms ease;
}

.qr-panel-toggle:hover,
.qr-panel-toggle:focus-visible {
    background: rgb(255 255 255 / 95%);
}

.qr-panel-toggle:focus-visible {
    outline: 2px solid rgb(59 130 246 / 45%);
    outline-offset: 1px;
}

.qr-panel-toggle-icon {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 150ms ease;
}

/* 展开后同一个箭头朝上, 表示可以收起 */
.qr-panel-toggle-icon--up {
    transform: rotate(180deg);
}

@media (max-width: 560px) {
    .qr-panel--page {
        flex-direction: column;
        align-items: stretch;
    }

    .qr-panel--page .qr-panel-preview {
        margin: 0 auto;
    }
}
</style>
