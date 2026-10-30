<script lang="ts" setup>
withDefaults(defineProps<{ leaving?: boolean }>(), { leaving: false });
</script>

<template>
    <!-- 一键截屏识别的整屏扫描动画: 纯展示, 不拦截页面交互 -->
    <div class="qr-scan" :class="{ 'qr-scan--leaving': leaving }" aria-hidden="true">
        <div class="qr-scan-mask" />
        <div class="qr-scan-beam" />
        <span class="qr-scan-corner corner-tl" />
        <span class="qr-scan-corner corner-tr" />
        <span class="qr-scan-corner corner-bl" />
        <span class="qr-scan-corner corner-br" />
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

.qr-scan--leaving {
    animation: qr-scan-fade-out 200ms ease both;
}

.qr-scan-mask {
    position: absolute;
    inset: 0;
    background: rgba(8, 12, 20, 0.22);
}

/* 单条白色光带自上而下扫过整个视口, 呼应"扫描整个屏幕" */
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
    /* 只扫一次: 动画结束即进入识别结果 */
    animation: qr-scan-sweep 700ms cubic-bezier(0.3, 0.6, 0.4, 1) 80ms forwards;
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
        transform: translateY(100vh);
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
