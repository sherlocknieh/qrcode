<script lang="ts" setup>
import { computed, ref } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
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

            <!-- 点击整块二维码展开/收起, 不再显示箭头; 悬停提示只说明点击动作 -->
            <button
                v-if="collapsible"
                class="qr-panel-toggle"
                type="button"
                :aria-expanded="expanded"
                :aria-label="expanded ? t('collapseEditor') : t('moreOptions')"
                :title="expanded ? t('collapseEditor') : t('moreOptions')"
                @click="toggleExpanded"
            >
                <!-- 收起态悬停时在二维码中央提示可以编辑 -->
                <svg
                    v-if="!expanded"
                    class="qr-panel-edit-icon"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                >
                    <path d="M10.7 2.4a1.5 1.5 0 0 1 2.1 0l.8.8a1.5 1.5 0 0 1 0 2.1l-7.2 7.2-3 .7.7-3z" />
                    <path d="m9.6 3.5 2.9 2.9" />
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

/* 顶部不留白, 靠二维码自带的静区白边分隔输入框 */
.qr-panel-form {
    box-sizing: border-box;
    padding: 0 8px 8px;
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

/* 展开入口: 透明的整块二维码热区, 点击即展开/收起 */
.qr-panel-toggle {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: none;
    border: 0;
    cursor: pointer;
}

/* 键盘聚焦时给出可见框, 鼠标点击不画框 */
.qr-panel-toggle:focus-visible {
    outline: 2px solid rgb(59 130 246 / 45%);
    outline-offset: -1px;
}

/* 编辑提示图标: 深色圆底保证在二维码黑块上也看得见, 平时隐藏 */
.qr-panel-edit-icon {
    box-sizing: content-box;
    width: 18px;
    height: 18px;
    padding: 8px;
    color: #ffffff;
    background: rgb(15 23 42 / 40%);
    border-radius: 50%;
    opacity: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: opacity 120ms ease;
}

/* 悬停提示只在能真正悬停的设备上出现, 触屏点完不会残留 */
@media (hover: hover) {
    .qr-panel-toggle:hover .qr-panel-edit-icon {
        opacity: 1;
    }
}

.qr-panel-toggle:focus-visible .qr-panel-edit-icon {
    opacity: 1;
}
</style>
