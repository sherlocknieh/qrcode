<script lang="ts" setup>
import { computed } from 'vue';

export type ScanRect = { x: number; y: number; width: number; height: number };

const props = withDefaults(
    defineProps<{
        // 不传表示整屏扫描; 传入矩形时只覆盖该区域 (网页图片扫描)
        rect?: ScanRect | null;
        // 扫过动画时长, 由调用方与 composable 的等待时长保持一致
        duration?: number;
        // 图片区域扫描时压在图片之上所需的层级; 不传则用兜底的最大值
        zIndex?: number | null;
        // 自带的压暗遮罩: 截图容器上播放时关掉, 它自己已经整屏压暗, 两层叠起来会明显发黑
        mask?: boolean;
        leaving?: boolean;
    }>(),
    { rect: null, duration: 700, zIndex: null, mask: true, leaving: false },
);

const region = computed(() => props.rect !== null);

const rootStyle = computed(() => {
    const rect = props.rect;
    const style: Record<string, string> = {
        // 光带用 transform 位移, 距离由容器高度决定
        '--scan-distance': rect ? `${Math.max(0, rect.height - 2)}px` : '100vh',
        '--scan-duration': `${props.duration}ms`,
    };
    if (rect) {
        style.left = `${rect.x}px`;
        style.top = `${rect.y}px`;
        style.width = `${rect.width}px`;
        style.height = `${rect.height}px`;
        // 修复图片区域动画盖住页面其他悬浮元素、压低后又整块看不见的问题:
        // 层级由调用方按图片所在层算出"刚好多一层", 不写死也不抬到最高
        if (props.zIndex !== null) style.zIndex = `${props.zIndex}`;
    }
    return style;
});
</script>

<template>
    <!-- 扫描动画: 整屏扫描时覆盖视口, 网页图片扫描时只覆盖图片区域; 纯展示, 不拦截交互 -->
    <div
        class="qr-scan"
        :class="{ 'qr-scan--region': region, 'qr-scan--leaving': leaving }"
        :style="rootStyle"
        aria-hidden="true"
    >
        <div v-if="props.mask" class="qr-scan-mask" />
        <div class="qr-scan-beam" />
        <template v-if="!region">
            <span class="qr-scan-corner corner-tl" />
            <span class="qr-scan-corner corner-tr" />
            <span class="qr-scan-corner corner-bl" />
            <span class="qr-scan-corner corner-br" />
        </template>
    </div>
</template>

<style scoped>
.qr-scan {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    overflow: hidden;
    pointer-events: none;
    animation: qr-scan-fade-in 160ms ease both;
}

/* 图片区域: 只覆盖图片, 用白色描边强调范围 */
.qr-scan--region {
    inset: auto;
    /* 动画挂在图片容器里, 靠排在图片之后压住图片即可;
       层级交给页面自身, 免得越过后加入的浮层(如维基的下载面板) */
    z-index: auto;
    box-shadow:
        0 0 0 2px rgba(255, 255, 255, 0.92),
        0 0 18px rgba(255, 255, 255, 0.55),
        0 0 0 1px rgba(0, 0, 0, 0.25);
}

.qr-scan--leaving {
    animation: qr-scan-fade-out 200ms ease both;
}

/* 暗色遮罩让白色光带在浅色页面/图片上都清晰可见 */
.qr-scan-mask {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.26);
}

/* 白色光带上下往返扫描, 直到解码结束才随遮罩淡出 */
.qr-scan-beam {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: #fff;
    box-shadow:
        0 0 18px 2px rgba(255, 255, 255, 0.85),
        0 0 4px rgba(0, 0, 0, 0.35);
    transform: translateY(-2px);
    /* alternate 让光带到底后原路返回, 不会从底部瞬移回顶部;
       对称缓动保证折返两端都平滑减速 */
    animation: qr-scan-sweep var(--scan-duration, 700ms) cubic-bezier(0.45, 0, 0.55, 1) 80ms infinite alternate;
}

.qr-scan-corner {
    position: absolute;
    width: 26px;
    height: 26px;
    border: 2px solid rgba(255, 255, 255, 0.85);
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.45));
    animation: qr-scan-corner 220ms ease both;
}

.corner-tl {
    top: 14px;
    left: 14px;
    border-right: 0;
    border-bottom: 0;
    border-top-left-radius: 8px;
}

.corner-tr {
    top: 14px;
    right: 14px;
    border-left: 0;
    border-bottom: 0;
    border-top-right-radius: 8px;
}

.corner-bl {
    bottom: 14px;
    left: 14px;
    border-right: 0;
    border-top: 0;
    border-bottom-left-radius: 8px;
}

.corner-br {
    bottom: 14px;
    right: 14px;
    border-left: 0;
    border-top: 0;
    border-bottom-right-radius: 8px;
}

@keyframes qr-scan-fade-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}

@keyframes qr-scan-fade-out {
    from {
        opacity: 1;
    }
    to {
        opacity: 0;
    }
}

@keyframes qr-scan-sweep {
    from {
        transform: translateY(-2px);
    }
    to {
        transform: translateY(var(--scan-distance, 100vh));
    }
}

@keyframes qr-scan-corner {
    from {
        opacity: 0;
        transform: scale(0.7);
    }
    to {
        opacity: 1;
        transform: scale(1);
    }
}

@media (prefers-reduced-motion: reduce) {
    .qr-scan,
    .qr-scan--leaving {
        animation-duration: 120ms;
    }

    .qr-scan-beam {
        display: none;
    }

    .qr-scan-corner {
        animation: none;
    }
}
</style>
