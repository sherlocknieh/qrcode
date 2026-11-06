<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import type { ScanRect } from '@/components/ScanAnimation.vue';
import { useCameraScanPanel } from '@/composables/useCameraScanPanel';
import { measureElementBox, measureImageRect } from '@/services/imageRect';
import { t } from '@/services/i18n';
import type { PopupNoticePayload } from '@/services/popupNotice';

const props = defineProps<{
    notify: (payload: PopupNoticePayload) => Promise<unknown>;
    runScan: (loader: () => Promise<ImageData>, errorTitle: string) => Promise<void>;
}>();

const emit = defineEmits<{ restarted: [] }>();

const root = ref<HTMLElement | null>(null);

const {
    video,
    active,
    starting,
    previewUrl,
    aspectRatio,
    mirrored,
    canFlip,
    start,
    stop,
    flip,
} = useCameraScanPanel({ notify: props.notify, runScan: props.runScan });

// 取景框跟随画面比例: 手机后置摄像头多是竖屏 3:4, 固定 16:9 会在两侧留出大片黑边
const stageStyle = computed(() => (
    aspectRatio.value ? { '--qr-camera-ratio': String(aspectRatio.value) } : undefined
));

// 提示只在画面已经存在时出现, 空态自带说明与开启按钮
const hint = computed(() => {
    if (previewUrl.value) return t('cameraPausedHint');
    if (!active.value && !starting.value) return t('cameraOffHint');
    return t('cameraHint');
});

// 画面在动时原来的绿点已经没有意义
watch(active, (running) => {
    if (running) emit('restarted');
});

// 扫描动画覆盖整个取景框
function measure(): Promise<ScanRect | undefined> {
    return Promise.resolve(measureElementBox(root.value));
}

// 结果绿点贴着暂停帧里实际绘制的画面
function measureResult(): ScanRect | undefined {
    const frame = root.value?.querySelector('img.qr-scan-media');
    return frame instanceof HTMLImageElement ? measureImageRect(frame) : measureElementBox(root.value);
}

defineExpose({ measure, measureResult, isMirrored: () => mirrored.value });
</script>

<template>
    <div ref="root" class="qr-scan-stage qr-scan-stage--camera" :style="stageStyle">
        <video
            v-show="!previewUrl"
            ref="video"
            class="qr-scan-media"
            :class="{ 'qr-scan-media--mirror': mirrored }"
            muted
            playsinline
        ></video>
        <img
            v-if="previewUrl"
            class="qr-scan-media"
            :class="{ 'qr-scan-media--mirror': mirrored }"
            :src="previewUrl"
            alt=""
        />
        <div v-if="active" class="qr-scan-frame" aria-hidden="true">
            <span class="qr-scan-frame-corner qr-scan-frame-corner--tl"></span>
            <span class="qr-scan-frame-corner qr-scan-frame-corner--tr"></span>
            <span class="qr-scan-frame-corner qr-scan-frame-corner--bl"></span>
            <span class="qr-scan-frame-corner qr-scan-frame-corner--br"></span>
        </div>
        <div v-if="!active && !previewUrl && !starting" class="qr-scan-camera-idle">
            <button
                class="qr-scan-camera-badge"
                type="button"
                :aria-label="t('retryCamera')"
                @click="start"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4.4 8.2 5.5 6.6A1 1 0 0 1 6.3 6h3.4a1 1 0 0 1 .8.6l1.1 1.6" />
                    <rect x="2" y="8.2" width="20" height="11.8" rx="2.4" />
                    <circle cx="12" cy="14.1" r="3.4" />
                </svg>
            </button>
            <p>{{ t('cameraIdle') }}</p>
        </div>
        <div v-if="starting" class="qr-scan-state">
            <span class="qr-scan-spinner" aria-hidden="true"></span>
            <p>{{ t('cameraStarting') }}</p>
        </div>
        <!-- 空态没有任何操作时不占位, 免得留下一个空的小黑块 -->
        <div v-if="canFlip || active || previewUrl" class="qr-scan-stage-tools">
            <button
                v-if="canFlip"
                class="qr-scan-tool"
                type="button"
                :title="t('switchCamera')"
                :aria-label="t('switchCamera')"
                :disabled="starting"
                @click="flip"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M20.4 9A8.6 8.6 0 0 0 5.6 5.6L3.5 7.7" />
                    <path d="M3.5 4.4v3.3h3.3" />
                    <path d="M3.6 15a8.6 8.6 0 0 0 14.8 3.4l2.1-2.1" />
                    <path d="M20.5 19.6v-3.3h-3.3" />
                </svg>
            </button>
            <button
                v-if="active"
                class="qr-scan-tool"
                type="button"
                :title="t('cameraStop')"
                :aria-label="t('cameraStop')"
                @click="stop"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="7" y="7" width="10" height="10" rx="1.8" />
                </svg>
            </button>
            <button
                v-else-if="previewUrl"
                class="qr-scan-tool qr-scan-tool--primary"
                type="button"
                :title="t('cameraResume')"
                :aria-label="t('cameraResume')"
                :disabled="starting"
                @click="start"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 7.3v9.4l7.4-4.7z" />
                </svg>
            </button>
        </div>
        <p v-if="hint" class="qr-scan-stage-hint">{{ hint }}</p>
    </div>
</template>

<style scoped>
/* 摄像头取景框跟随画面比例, 高度封顶后再按同一比例收窄宽度,
   竖屏手机画面才不会把面板撑出窗口 */
.qr-scan-stage.qr-scan-stage--camera {
    --qr-camera-max-height: min(56vh, 520px);
    width: min(100%, calc(var(--qr-camera-max-height) * var(--qr-camera-ratio, 1.7778)));
    margin-inline: auto;
    aspect-ratio: var(--qr-camera-ratio, 16 / 9);
    /* 虚线不能再用 border: 1.5px 会占进盒子, 而 aspect-ratio 算的是含边框的尺寸,
       内容盒因此比画面略宽, object-fit: contain 会在左右各留一道细缝 */
    border: 0;
}

/* 虚线改由覆盖层画在边框原本的位置, 布局盒与画面比例完全一致 */
.qr-scan-stage--camera::after {
    content: '';
    position: absolute;
    inset: 0;
    border: 1.5px dashed #cbd5e1;
    border-radius: inherit;
    pointer-events: none;
}

.qr-scan-media {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 10px;
    object-fit: contain;
}

/* 镜像只用在正对用户的摄像头上, 手机后置画面保持真实朝向 */
.qr-scan-media--mirror {
    transform: scaleX(-1);
}

/* 四角取景框: 与整屏扫描动画同一套白色括号语言, 比虚线更聚焦 */
.qr-scan-frame {
    position: absolute;
    inset: 9%;
    pointer-events: none;
}

.qr-scan-frame-corner {
    position: absolute;
    width: 34px;
    height: 34px;
    border: 2px solid rgba(255, 255, 255, 0.85);
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.45));
}

.qr-scan-frame-corner--tl {
    top: 0;
    left: 0;
    border-right: 0;
    border-bottom: 0;
    border-top-left-radius: 10px;
}

.qr-scan-frame-corner--tr {
    top: 0;
    right: 0;
    border-left: 0;
    border-bottom: 0;
    border-top-right-radius: 10px;
}

.qr-scan-frame-corner--bl {
    bottom: 0;
    left: 0;
    border-right: 0;
    border-top: 0;
    border-bottom-left-radius: 10px;
}

.qr-scan-frame-corner--br {
    bottom: 0;
    right: 0;
    border-left: 0;
    border-top: 0;
    border-bottom-right-radius: 10px;
}

/* 摄像头未开启: 图标按钮 + 一句说明填满浅色取景框 */
.qr-scan-camera-idle,
.qr-scan-state {
    position: absolute;
    inset: 8px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    border-radius: 10px;
}

.qr-scan-camera-idle {
    color: #64748b;
}

.qr-scan-camera-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border: 1px solid #e2e8f0;
    border-radius: 50%;
    background: #f8fafc;
    color: inherit;
    cursor: pointer;
    font: inherit;
    transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}

.qr-scan-camera-badge:hover {
    border-color: #bfdbfe;
    background: #eff6ff;
}

.qr-scan-camera-badge:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 3px;
}

.qr-scan-camera-badge:active {
    transform: translateY(1px);
}

.qr-scan-camera-badge svg {
    width: 28px;
    height: 28px;
    margin: 0;
    opacity: 1;
    fill: none;
    stroke: #94a3b8;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.qr-scan-camera-idle p {
    margin: 0;
    font-size: 12.5px;
    letter-spacing: 0.02em;
}

.qr-scan-state {
    color: #475569;
    font-size: 13px;
    letter-spacing: 0.02em;
}

.qr-scan-state p {
    margin: 0;
}

.qr-scan-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid #e2e8f0;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: qr-scan-spin 0.9s linear infinite;
}

@keyframes qr-scan-spin {
    to {
        transform: rotate(360deg);
    }
}

/* 深色画面上操作条用半透明深底, 白色按钮才压得住 */
.qr-scan-stage.qr-scan-stage--camera .qr-scan-stage-tools {
    background: rgba(15, 23, 42, 0.62);
}

@media (prefers-reduced-motion: reduce) {
    .qr-scan-spinner {
        animation-duration: 2s;
    }
}
</style>
