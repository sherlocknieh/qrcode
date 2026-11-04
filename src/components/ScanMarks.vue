<script lang="ts" setup>
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { t } from '@/services/i18n';

// 扫描命中后标出码的位置: 每个码上叠可点击蓝点, 由用户选用哪一个
const props = defineProps<{ rects: ScanRect[] }>();
const emit = defineEmits<{ pick: [index: number] }>();

const pickHint = t('pickCodeHint');

const rectStyle = (rect: ScanRect) => ({
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
});

// 蓝点压在码中央: 尺寸跟随码的大小, 小码也留出足够的可点面积
function dotStyle(rect: ScanRect) {
    const size = Math.round(Math.min(56, Math.max(26, Math.min(rect.width, rect.height) * 0.42)));
    return { width: `${size}px`, height: `${size}px` };
}
</script>

<template>
    <Transition name="qr-marks-fade">
        <div v-if="props.rects.length" class="qr-marks-root">
            <div
                v-for="(rect, index) in props.rects"
                :key="index"
                class="qr-marks-item"
                :style="rectStyle(rect)"
            >
                <span class="qr-marks-box" />
                <button
                    type="button"
                    class="qr-marks-dot"
                    :style="dotStyle(rect)"
                    :title="pickHint"
                    :aria-label="pickHint"
                    @click="emit('pick', index)"
                >
                    <svg class="qr-marks-dot-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 12h13m-5-6 6 6-6 6" />
                    </svg>
                </button>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.qr-marks-root {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    overflow: hidden;
    pointer-events: none;
}

/* 页面全局样式会泄漏进注入的 UI, 这里显式兜底边距、透明度与盒模型 */
.qr-marks-item {
    position: absolute;
    box-sizing: content-box;
    margin: 0;
    padding: 0;
    opacity: 1;
    animation: qr-marks-pop 200ms ease both;
}

.qr-marks-box {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    opacity: 1;
    border: 2px solid #2cabff;
    border-radius: 6px;
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(44, 171, 255, 0.55);
}

/* 只有蓝点接管点击: 空白点击由 useCodePicker 在 document 上判断, 不挡住页面与面板按钮 */
.qr-marks-dot {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    margin: auto;
    padding: 0;
    opacity: 1;
    appearance: none;
    border: 2px solid #fff;
    border-radius: 50%;
    background: #2cabff;
    box-shadow:
        0 0 0 2px rgba(44, 171, 255, 0.55),
        0 2px 8px rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    pointer-events: auto;
    transition:
        transform 140ms ease,
        background-color 140ms ease;
}

.qr-marks-dot:hover {
    transform: scale(1.08);
    background: #1e9bf0;
}

.qr-marks-dot:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
}

.qr-marks-dot-icon {
    width: 62%;
    height: 62%;
    margin: 0;
    padding: 0;
    opacity: 1;
    fill: none;
    stroke: #fff;
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

@keyframes qr-marks-pop {
    from {
        opacity: 0;
        transform: scale(1.06);
    }

    to {
        opacity: 1;
        transform: scale(1);
    }
}

.qr-marks-fade-enter-active,
.qr-marks-fade-leave-active {
    transition: opacity 200ms ease;
}

.qr-marks-fade-enter-from,
.qr-marks-fade-leave-to {
    opacity: 0;
}
</style>
