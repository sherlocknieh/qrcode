<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ImagePicker from '@/components/ImagePicker.vue';
import { useCameraScan } from '@/composables/useCameraScan';
import { useImageSource } from '@/composables/useImageSource';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { errorNotice } from '@/services/decodeResultNotice';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage } from '@/services/recognize';
import { t } from '@/services/i18n';
import { trySendMessage } from '@/services/messaging';

// 识别面板: 图片与摄像头是同一个面板的两种输入源, 共享同一套
// 取景框 / 提示 / 按钮布局, 以及同一条识别流水线 (recognizeImage)。
// 源只负责产出一张图像, 识别、提示、重试与结果展示不再各写一套。
type ScanMode = 'image' | 'camera';

const props = withDefaults(
    defineProps<{
        // page: 独立识别页的整页卡片; overlay: 页面内浮层
        variant?: 'page' | 'overlay';
        mode?: ScanMode;
    }>(),
    { variant: 'page', mode: 'image' },
);

const emit = defineEmits<{
    (event: 'close'): void;
    (event: 'update:mode', value: ScanMode): void;
    // 浮层里的摄像头受页面安全上下文与权限策略限制, 启动失败时交给宿主换扩展页重试
    (event: 'camera-unavailable'): void;
}>();

const overlay = props.variant === 'overlay';
const mode = ref<ScanMode>(props.mode);
watch(() => props.mode, (value) => {
    if (value !== mode.value) mode.value = value;
});
const isCamera = computed(() => mode.value === 'camera');

const { host, notify } = useNoticeFallback();
const scanAnimation = useScanAnimation();
const recognizing = ref(false);

// ---------------------------- 共用识别流水线 ----------------------------

async function runScan(
    loader: () => Promise<ImageData>,
    options: { errorTitle?: string; onRetry?: () => void } = {},
) {
    if (recognizing.value) return;
    recognizing.value = true;
    try {
        await recognizeImage(loader, {
            host,
            errorTitle: options.errorTitle,
            beforeNotice: playScanAnimation,
            afterDecode: () => scanAnimation.stop(),
            onRetry: options.onRetry,
        });
    } finally {
        recognizing.value = false;
    }
}

const stageRef = ref<HTMLElement | null>(null);
const picker = ref<InstanceType<typeof ImagePicker> | null>(null);

// 扫描动画跟随当前源: 图片在预览图上, 摄像头在取景框上
async function playScanAnimation() {
    const pickerRoot = picker.value?.$el as HTMLElement | undefined;
    const target = isCamera.value
        ? stageRef.value
        : pickerRoot?.querySelector('.qr-picker-preview');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    await scanAnimation.play({ rect });
}

// ---------------------------- 图片源 ----------------------------

const { previewUrl, loadBlob, clear } = useImageSource({ notify });

// 选中/粘贴/拖入即识别
async function handleFile(blob: Blob) {
    if (recognizing.value) return;
    if (!(await loadBlob(blob))) return;
    // 预览先渲染出来, 扫描动画才能定位到图片区域
    await nextTick();
    await scanImage();
}

function scanImage() {
    if (!previewUrl.value || recognizing.value) return;
    return runScan(
        () => getImageDataFromDataUrl(previewUrl.value),
        {
            errorTitle: t('imageFetchFailed'),
            // 浮层可以真的去截当前页; 独立识别页截图只会截到自己, 不给这个出口
            onRetry: overlay ? () => void trySendMessage('requestScreenshot') : undefined,
        },
    );
}

// ---------------------------- 摄像头源 ----------------------------

const video = ref<HTMLVideoElement | null>(null);
const {
    active: cameraActive,
    starting: cameraStarting,
    previewUrl: cameraPreview,
    start: startCamera,
    stop: stopCamera,
} = useCameraScan({
    video,
    // 命中一帧就停: 这一帧交给共用流水线, 多码补全由 recognizeImage 完成
    onFrame: (frame) => runScan(async () => frame, { errorTitle: t('cameraFailed') }),
    onError: handleCameraError,
});

// 把浏览器抛出的设备错误翻译成用户能理解的文案
function describeCameraError(error: unknown): string {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return t('cameraPermissionDenied');
    if (name === 'NotFoundError') return t('cameraNotFound');
    if (name === 'NotReadableError' || name === 'AbortError') return t('cameraBusy');
    return error instanceof Error ? error.message : String(error);
}

async function handleCameraError(error: unknown) {
    if (overlay) {
        // 浮层受页面限制时无法保证可用: 交给宿主在扩展页里重试
        emit('camera-unavailable');
        return;
    }
    await notify(errorNotice(t('cameraFailed'), describeCameraError(error)));
}

// ---------------------------- 布局与交互 ----------------------------

const title = computed(() => t(isCamera.value ? 'cameraScanTitle' : 'scanImageTitle'));

// 提示始终占一行, 换源不改变面板高度
const hint = computed(() => {
    if (isCamera.value) {
        if (cameraPreview.value) return t('cameraPausedHint');
        if (!cameraActive.value && !cameraStarting.value) return t('cameraOffHint');
        return t('cameraHint');
    }
    return previewUrl.value ? t('previewHint') : t('pasteImageHint');
});

const switchLabel = computed(() => t(isCamera.value ? 'switchToImageScan' : 'switchToCameraScan'));

type PanelAction = { label: string; primary?: boolean; disabled?: boolean; run: () => void };

// 按钮由当前源描述, 模板不再按模式分支
const actions = computed<PanelAction[]>(() => {
    if (isCamera.value) {
        if (cameraActive.value) return [{ label: t('cameraStop'), run: stopCamera }];
        if (cameraPreview.value) return [{ label: t('cameraResume'), primary: true, run: startCamera }];
        return [{
            label: t('retryCamera'),
            primary: true,
            disabled: cameraStarting.value,
            run: startCamera,
        }];
    }
    if (previewUrl.value) {
        return [
            { label: t('clearImage'), disabled: recognizing.value, run: clear },
            { label: t('scanNow'), primary: true, disabled: recognizing.value, run: () => void scanImage() },
        ];
    }
    return [{
        label: t('chooseImage'),
        primary: true,
        disabled: recognizing.value,
        run: () => picker.value?.pickFile(),
    }];
});

function switchSource() {
    const next: ScanMode = isCamera.value ? 'image' : 'camera';
    mode.value = next;
    emit('update:mode', next);
}

// 切换源时同步摄像头: 离开立即释放, 进入时等 video 渲染出来再请求
watch(isCamera, (camera) => {
    if (camera) void startCamera();
    else stopCamera();
}, { flush: 'post' });

onMounted(() => {
    if (isCamera.value) void startCamera();
});

function onKeydown(event: KeyboardEvent) {
    if (!overlay || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown, true));

onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true);
    void scanAnimation.stop();
});
</script>

<template>
    <!-- 浮层宿主: Teleport 到 body 并自带遮罩; 独立页宿主: 原地渲染, 由页面负责居中 -->
    <Teleport to="body" :disabled="!overlay">
        <div :class="overlay ? 'qr-scan-backdrop' : 'qr-scan-wrap'" @click.self="overlay && emit('close')">
            <section
                class="qr-scan-panel"
                :class="{ 'qr-scan-panel--overlay': overlay }"
                role="dialog"
                :aria-modal="overlay ? 'true' : undefined"
            >
                <header class="qr-scan-panel-header">
                    <component :is="overlay ? 'p' : 'h1'" class="qr-scan-panel-title">
                        {{ title }}
                    </component>

                    <div class="qr-scan-panel-tools">
                        <!-- 切换源: 独立页带文字说明, 浮层只留图标 -->
                        <button
                            class="qr-scan-tool qr-scan-tool--switch"
                            type="button"
                            :title="switchLabel"
                            :aria-label="switchLabel"
                            @click="switchSource"
                        >
                            <svg v-if="isCamera" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <circle cx="8.5" cy="8.5" r="1.5" />
                                <path d="m21 15-4.5-4.5L7 20" />
                            </svg>
                            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M4.4 8.2 5.5 6.6A1 1 0 0 1 6.3 6h3.4a1 1 0 0 1 .8.6l1.1 1.6" />
                                <rect x="2" y="8.2" width="20" height="11.8" rx="2.4" />
                                <circle cx="12" cy="14.1" r="3.4" />
                            </svg>
                            <span v-if="!overlay" class="qr-scan-tool-label">{{ switchLabel }}</span>
                        </button>

                        <button
                            v-if="overlay"
                            class="qr-scan-tool qr-scan-tool--close"
                            type="button"
                            :aria-label="t('closeBtn')"
                            :title="t('closeBtn')"
                            @click="emit('close')"
                        >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                                <path d="m4 4 8 8M12 4l-8 8" />
                            </svg>
                        </button>
                    </div>
                </header>

                <!-- 取景框: 摄像头是视频画面, 图片是取图/预览区, 尺寸与圆角一致 -->
                <div
                    ref="stageRef"
                    class="qr-scan-stage"
                    :class="{ 'qr-scan-stage--camera': isCamera }"
                >
                    <template v-if="isCamera">
                        <video
                            v-show="!cameraPreview"
                            ref="video"
                            class="qr-scan-media"
                            muted
                            playsinline
                        ></video>
                        <img v-if="cameraPreview" class="qr-scan-media" :src="cameraPreview" alt="" />
                        <div v-if="cameraActive" class="qr-scan-frame" aria-hidden="true">
                            <span class="qr-scan-frame-corner qr-scan-frame-corner--tl"></span>
                            <span class="qr-scan-frame-corner qr-scan-frame-corner--tr"></span>
                            <span class="qr-scan-frame-corner qr-scan-frame-corner--bl"></span>
                            <span class="qr-scan-frame-corner qr-scan-frame-corner--br"></span>
                        </div>
                        <!-- 未开启时给黑色取景框一个明确的空状态, 不再是纯黑一块 -->
                        <div
                            v-if="!cameraActive && !cameraPreview && !cameraStarting"
                            class="qr-scan-camera-idle"
                        >
                            <span class="qr-scan-camera-badge">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4.4 8.2 5.5 6.6A1 1 0 0 1 6.3 6h3.4a1 1 0 0 1 .8.6l1.1 1.6" />
                                    <rect x="2" y="8.2" width="20" height="11.8" rx="2.4" />
                                    <circle cx="12" cy="14.1" r="3.4" />
                                </svg>
                            </span>
                            <p>{{ t('cameraIdle') }}</p>
                        </div>
                        <div v-if="cameraStarting" class="qr-scan-state">
                            <span class="qr-scan-spinner" aria-hidden="true"></span>
                            <p>{{ t('cameraStarting') }}</p>
                        </div>
                    </template>
                    <ImagePicker
                        v-else
                        ref="picker"
                        :preview-url="previewUrl"
                        :busy="recognizing"
                        @file="handleFile"
                    />
                </div>

                <!-- 提示与按钮始终占位, 换源时面板长宽不变 -->
                <p class="qr-scan-hint">{{ hint }}</p>

                <div class="qr-scan-panel-actions">
                    <button
                        v-for="action in actions"
                        :key="action.label"
                        type="button"
                        class="qr-scan-panel-btn"
                        :class="{ 'qr-scan-panel-btn--primary': action.primary }"
                        :disabled="action.disabled"
                        @click="action.run"
                    >{{ action.label }}</button>
                </div>

                <p v-if="!overlay" class="qr-scan-panel-foot">{{ t('scanPanelFooter') }}</p>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.qr-scan-wrap {
    display: contents;
}

/* 浮层宿主: 覆盖页面并居中面板, 用中性暗遮罩压住页面 */
.qr-scan-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(15, 23, 42, 0.45);
    animation: qr-scan-fade 140ms ease both;
}

@keyframes qr-scan-fade {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}

.qr-scan-panel {
    position: relative;
    box-sizing: border-box;
    /* 两种承载使用同一宽度, 只在外边距与阴影上有区别 */
    width: min(560px, 100%);
    padding: 26px;
    border: 1px solid #e2e8f0;
    border-radius: 18px;
    background: #fff;
    box-shadow:
        0 1px 2px rgba(15, 23, 42, 0.04),
        0 24px 60px -24px rgba(15, 23, 42, 0.22);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1f2937;
    animation: qr-scan-enter 180ms ease both;
}

@keyframes qr-scan-enter {
    from {
        opacity: 0;
        transform: translateY(8px);
    }
    to {
        opacity: 1;
        transform: none;
    }
}

/* 浮层里没有页面边距, 需要自己限制最大宽度并收紧留白;
   小窗口下允许面板内部滚动, 避免整体溢出视口 */
.qr-scan-panel--overlay {
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 18px 18px 20px;
    border-color: #e2e8f0;
    border-radius: 16px;
}

/* 标题栏: 标题左对齐, 工具按钮收在右侧, 高度固定 */
.qr-scan-panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 32px;
    margin-bottom: 16px;
}

.qr-scan-panel-title {
    flex: 1 1 auto;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: #0f172a;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.qr-scan-panel-tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
}

/* 工具按钮: 细边框方块, 悬停转为琥珀色, 只在需要时出现 */
.qr-scan-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #fff;
    color: #64748b;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
}

/* 独立页把切换源做成带文字的胶囊, 比纯图标更容易发现 */
.qr-scan-tool--switch {
    width: auto;
    padding: 0 11px 0 9px;
    border-radius: 999px;
}

.qr-scan-tool-label {
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
}

.qr-scan-tool:hover {
    border-color: #bfdbfe;
    background: #f9fafb;
    color: #1d4ed8;
}

.qr-scan-tool:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 2px;
}

/* 完整声明 margin/opacity: 页面全局 svg 规则会作用到注入的浮层上 */
.qr-scan-tool svg {
    width: 18px;
    height: 18px;
    margin: 0;
    opacity: 1;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 关闭按钮去掉边框, 与切换按钮区分层级 */
.qr-scan-tool--close {
    border-color: transparent;
    background: transparent;
}

.qr-scan-tool--close svg {
    width: 16px;
    height: 16px;
}

.qr-scan-tool--close:hover {
    border-color: transparent;
    background: #f1f5f9;
    color: #0f172a;
}

/* 取景框: 图片模式是白色取图区, 摄像头模式才用深色底 */
.qr-scan-stage {
    position: relative;
    box-sizing: border-box;
    aspect-ratio: 4 / 3;
    overflow: hidden;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    background: #fff;
}

.qr-scan-stage--camera {
    background: #0f172a;
}

/* 取图区占满取景框, 内容居中; 虚线边框正好充当取景提示 */
.qr-scan-stage .qr-picker {
    height: 100%;
    justify-content: center;
}

.qr-scan-stage :deep(.qr-picker-figure) {
    flex: 1 1 auto;
    height: auto;
    min-height: 0;
}

.qr-scan-stage :deep(.qr-picker-preview) {
    height: 100%;
}

.qr-scan-media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
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

/* 摄像头未开启: 用图标 + 一句说明填满深色取景框 */
.qr-scan-camera-idle {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: #94a3b8;
}

.qr-scan-camera-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.06);
}

.qr-scan-camera-badge svg {
    width: 28px;
    height: 28px;
    margin: 0;
    opacity: 1;
    fill: none;
    stroke: #cbd5e1;
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
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin: 0;
    background: rgba(15, 23, 42, 0.72);
    color: #e2e8f0;
    font-size: 13px;
    letter-spacing: 0.02em;
}

.qr-scan-state p {
    margin: 0;
}

.qr-scan-spinner {
    width: 22px;
    height: 22px;
    border: 2px solid rgba(226, 232, 240, 0.28);
    border-top-color: #e2e8f0;
    border-radius: 50%;
    animation: qr-scan-spin 0.9s linear infinite;
}

@keyframes qr-scan-spin {
    to {
        transform: rotate(360deg);
    }
}

/* 固定一行高度: 文案长短或换源都不改变面板尺寸 */
.qr-scan-hint {
    height: 20px;
    margin: 12px 0 0;
    overflow: hidden;
    text-align: center;
    font-size: 12.5px;
    line-height: 20px;
    color: #64748b;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.qr-scan-panel-actions {
    display: flex;
    gap: 10px;
    margin-top: 16px;
}

/* 固定高度: 一个按钮与两个按钮、换源后都保持同一行高 */
.qr-scan-panel-btn {
    flex: 1 1 0;
    min-width: 0;
    height: 42px;
    padding: 0 18px;
    border: 1px solid #d1d5db;
    border-radius: 11px;
    background: #fff;
    color: #1f2937;
    font: inherit;
    font-weight: 500;
    letter-spacing: 0.01em;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.qr-scan-panel-btn:hover:not(:disabled) {
    border-color: #9ca3af;
    background: #f9fafb;
}

.qr-scan-panel-btn:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 2px;
}

/* 主操作: 品牌蓝实底, 与通知弹窗的主按钮保持一致 */
.qr-scan-panel-btn--primary {
    border-color: #2563eb;
    background: #2563eb;
    color: #ffffff;
}

.qr-scan-panel-btn--primary:hover:not(:disabled) {
    border-color: #1d4ed8;
    background: #1d4ed8;
}

.qr-scan-panel-btn:disabled {
    opacity: 0.45;
    cursor: default;
}

/* 浮层空间更紧凑: 标题缩小, 取景框与按钮的相对关系保持不变 */
.qr-scan-panel--overlay .qr-scan-panel-header {
    min-height: 30px;
    margin-bottom: 12px;
}

.qr-scan-panel--overlay .qr-scan-panel-title {
    font-size: 14px;
}

.qr-scan-panel--overlay .qr-scan-hint {
    margin-top: 10px;
}

.qr-scan-panel--overlay .qr-scan-panel-actions {
    margin-top: 14px;
}

.qr-scan-panel--overlay .qr-scan-panel-btn {
    height: 40px;
}

/* 页脚只在独立页出现, 补充能力说明 */
.qr-scan-panel-foot {
    margin: 14px 0 0;
    text-align: center;
    font-size: 12px;
    line-height: 1.5;
    color: #64748b;
}

.qr-scan-panel--overlay .qr-scan-tool--switch {
    width: 32px;
    padding: 0;
    border-radius: 10px;
}

@media (prefers-reduced-motion: reduce) {
    .qr-scan-panel,
    .qr-scan-backdrop {
        animation-duration: 1ms;
    }

    .qr-scan-spinner {
        animation-duration: 2s;
    }
}
</style>
