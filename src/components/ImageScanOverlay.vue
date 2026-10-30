<script lang="ts" setup>
import { computed } from 'vue';

const props = withDefaults(
    defineProps<{
        x: number;
        y: number;
        width: number;
        height: number;
        leaving?: boolean;
    }>(),
    { leaving: false },
);

const rootStyle = computed(() => ({
    left: `${props.x}px`,
    top: `${props.y}px`,
    width: `${props.width}px`,
    height: `${props.height}px`,
}));
</script>

<template>
    <!-- 图片识别时的局部扫描动画: 只高亮图片区域, 不遮挡页面交互 -->
    <div class="qr-img-scan" :class="{ 'qr-img-scan--leaving': leaving }" :style="rootStyle" aria-hidden="true">
        <div class="qr-img-scan-mask" />
        <div class="qr-img-scan-beam" />
    </div>
</template>

<style scoped>
.qr-img-scan {
    position: fixed;
    z-index: 2147483646;
    border-radius: 6px;
    box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.92),
        0 0 18px rgba(255, 255, 255, 0.55),
        0 0 0 1px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    pointer-events: none;
    animation: qr-img-scan-in 140ms ease both;
}

.qr-img-scan--leaving {
    animation: qr-img-scan-out 200ms ease both;
}

/* 与整屏扫描一致的暗色遮罩, 让白色光带在浅色图片上也清晰可见 */
.qr-img-scan-mask {
    position: absolute;
    inset: 0;
    background: rgba(8, 12, 20, 0.22);
}

/* 单条白色光带在图片范围内自上而下扫过 */
.qr-img-scan-beam {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: #fff;
    box-shadow:
        0 0 14px 2px rgba(255, 255, 255, 0.9),
        0 0 4px rgba(0, 0, 0, 0.35);
    animation: qr-img-scan-sweep 640ms cubic-bezier(0.3, 0.6, 0.4, 1) 60ms forwards;
}

@keyframes qr-img-scan-in {
    from {
        opacity: 0;
        transform: scale(0.98);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

@keyframes qr-img-scan-out {
    from {
        opacity: 1;
    }
    to {
        opacity: 0;
    }
}

@keyframes qr-img-scan-sweep {
    from {
        top: 0;
    }
    to {
        top: calc(100% - 2px);
    }
}

@media (prefers-reduced-motion: reduce) {
    .qr-img-scan-beam {
        display: none;
    }

    .qr-img-scan,
    .qr-img-scan--leaving {
        animation-duration: 120ms;
    }
}
</style>
