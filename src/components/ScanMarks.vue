<script lang="ts" setup>
import type { ScanRect } from '@/components/ScanOverlay.vue';

// 全屏扫描成功后标出码的位置: 纯展示, 不拦截页面交互
defineProps<{ rects: ScanRect[] }>();
</script>

<template>
    <Transition name="qr-marks-fade">
        <div v-if="rects.length" class="qr-marks-root" aria-hidden="true">
            <span
                v-for="(rect, index) in rects"
                :key="index"
                class="qr-marks-box"
                :style="{
                    left: `${rect.x}px`,
                    top: `${rect.y}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                }"
            />
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
.qr-marks-box {
    position: absolute;
    box-sizing: content-box;
    margin: 0;
    padding: 0;
    opacity: 1;
    border: 2px solid #2cabff;
    border-radius: 6px;
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(44, 171, 255, 0.55);
    animation: qr-marks-pop 200ms ease both;
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
