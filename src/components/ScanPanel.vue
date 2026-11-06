<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ImagePicker from '@/components/ImagePicker.vue';
import ScanMarks from '@/components/ScanMarks.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { useCameraScan } from '@/composables/useCameraScan';
import { useCodePicker } from '@/composables/useCodePicker';
import { useImageSource } from '@/composables/useImageSource';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { errorNotice } from '@/services/decodeResultNotice';
import { measureImageRect } from '@/services/imageRect';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage, type RetryKind } from '@/services/recognize';
import { t } from '@/services/i18n';
import { trySendMessage } from '@/services/messaging';

// 扫描面板: 图片与摄像头是同一个面板的两种输入源, 共享同一套
// 取景框 / 提示 / 按钮布局, 以及同一条扫描流水线 (recognizeImage)。
// 源只负责产出一张图像, 扫描、提示、重试与结果展示不再各写一套。
// 源由宿主决定 (扫描页按 ?camera=1 进入), 面板内不再互相切换:
// 面板只有标题栏与取景框。标题栏右侧只有当前源的主操作带文字,
// 其余是图标按钮; 空态的选择入口与说明放在取图区里, 画面出现后提示压在取景框底部。
type ScanMode = 'image' | 'camera';

const props = withDefaults(
    defineProps<{
        // page: 独立扫描页的整页卡片; overlay: 页面内浮层
        variant?: 'page' | 'overlay';
        mode?: ScanMode;
    }>(),
    { variant: 'page', mode: 'image' },
);

const emit = defineEmits<{
    (event: 'close'): void;
    // 浮层里的摄像头受页面安全上下文与权限策略限制, 启动失败时交给宿主换扩展页重试
    (event: 'camera-unavailable'): void;
}>();

const overlay = props.variant === 'overlay';
const isCamera = computed(() => props.mode === 'camera');

const { host, notify, notifyPickedResults, notifyResults } = useNoticeFallback();
const scanAnimation = useScanAnimation();
const recognizing = ref(false);
// 与其它入口一致: 命中码后在预览图上叠绿点, 点哪个就把通知切到哪个码
const codePicker = useCodePicker({ notifyResults });
const marks = codePicker.marks;
const pickedFlags = codePicker.pickedFlags;
const pickMark = codePicker.pick;
const clearMarks = codePicker.clear;

// ---------------------------- 共用扫描流水线 ----------------------------

async function runScan(
    loader: () => Promise<ImageData>,
    options: { errorTitle?: string; onRetry?: () => void; noResultRetry?: RetryKind } = {},
) {
    if (recognizing.value) return;
    recognizing.value = true;
    codePicker.clear();
    try {
        const outcome = await recognizeImage(loader, {
            host,
            errorTitle: options.errorTitle,
            beforeNotice: playScanAnimation,
            afterDecode: () => scanAnimation.stop(),
            onRetry: options.onRetry,
            noResultRetry: options.noResultRetry,
            // 结果通知与绿点同时给出, 由这里统一处理
            deferResults: true,
        });
        if (outcome.status !== 'ok') return;
        // 摄像头命中后才会切到暂停帧, 等它渲染出来再量区域
        await nextTick();
        const rect = measurePreview();
        if (rect) {
            codePicker.show(outcome.results, {
                rect,
                imageSize: outcome.imageSize,
                scroll: { x: window.scrollX, y: window.scrollY },
                viewportWidth: window.innerWidth,
                // 浮层固定不动, 独立页里的卡片会随页面滚动
                followScroll: !overlay,
                // 画面镜像显示时才需要翻转横向坐标才能压住码
                mirrorX: isCamera.value && cameraMirrored.value,
            });
            // 多条结果只留绿点, 点哪条再出哪条的通知
            await notifyPickedResults(outcome.results);
            return;
        }
        // 量不出预览区域就叠不了绿点, 仍由通知把结果列出来
        await notifyResults(outcome.results);
    } finally {
        recognizing.value = false;
    }
}

// 当前源在画面上的区域: 图片用预览图, 摄像头用暂停帧
function measurePreview(): ScanRect | undefined {
    const element = isCamera.value
        ? stageRef.value?.querySelector('img.qr-scan-media')
        : picker.value?.$el.querySelector('.qr-picker-preview');
    if (element instanceof HTMLImageElement) return measureImageRect(element);
    return measureBlock(stageRef.value);
}

// 取景框跟着相机画面比例走: 手机上后置摄像头多是竖屏 3:4,
// 固定 16:9 会把画面缩在中间, 两侧留出大片黑边
const stageStyle = computed(() => (
    isCamera.value && cameraRatio.value
        ? { '--qr-camera-ratio': String(cameraRatio.value) }
        : undefined
));

const stageRef = ref<HTMLElement | null>(null);
const picker = ref<InstanceType<typeof ImagePicker> | null>(null);

// 扫描动画跟随当前源: 图片贴合图片像素本身, 摄像头在取景框上
async function playScanAnimation() {
    const rect = isCamera.value
        ? measureBlock(stageRef.value)
        : await measureImage(picker.value?.$el.querySelector('.qr-picker-preview'));
    if (!rect) return;
    await scanAnimation.play({ rect });
}

// 取景框是普通块元素, 盒子即动画区域
function measureBlock(element: HTMLElement | null): ScanRect | undefined {
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return undefined;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

// 预览图用 object-fit: contain 铺满取景框, 元素盒子比实际图像大;
// 按固有尺寸算出居中后的图像矩形, 让光带只扫过图片而不是整块黑底
async function measureImage(element: Element | null): Promise<ScanRect | undefined> {
    if (!(element instanceof HTMLImageElement)) return undefined;
    // data URL 的图片在 DOM 更新后仍可能在解码, 解码完成才有固有尺寸
    if (!element.complete) await element.decode().catch(() => undefined);
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return undefined;

    const { naturalWidth, naturalHeight } = element;
    if (!naturalWidth || !naturalHeight) {
        return { x: box.left, y: box.top, width: box.width, height: box.height };
    }

    const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    return {
        x: box.left + (box.width - width) / 2,
        y: box.top + (box.height - height) / 2,
        width,
        height,
    };
}

// ---------------------------- 图片源 ----------------------------

const { previewUrl, loadBlob, clear } = useImageSource({ notify });

// 选中/粘贴/拖入即扫描
async function handleFile(blob: Blob) {
    if (recognizing.value) return;
    if (!(await loadBlob(blob))) return;
    // 预览先渲染出来, 扫描动画才能定位到图片区域
    await nextTick();
    await scanLocalImage();
}

function scanLocalImage() {
    if (!previewUrl.value || recognizing.value) return;
    return runScan(
        () => getImageDataFromDataUrl(previewUrl.value),
        {
            errorTitle: t('imageFetchFailed'),
            // 浮层可以真的去截当前页再让用户框选: 先收起浮层再截屏, 否则截到的是浮层自己;
            // 独立扫描页截图只会截到自己, 不给这个出口
            onRetry: overlay
                ? () => {
                    emit('close');
                    void trySendMessage('requestFrameScan');
                }
                : undefined,
            noResultRetry: overlay ? 'frameScan' : undefined,
        },
    );
}

// ---------------------------- 摄像头源 ----------------------------

const video = ref<HTMLVideoElement | null>(null);
const {
    active: cameraActive,
    starting: cameraStarting,
    previewUrl: cameraPreview,
    aspectRatio: cameraRatio,
    mirrored: cameraMirrored,
    canFlip: cameraCanFlip,
    start: startCamera,
    stop: stopCamera,
    flip: flipCamera,
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

const title = computed(() => t(isCamera.value ? 'scanCamera' : 'scanLocalImageTitle'));

// 提示压在取景框底部, 只用于"画面已经有了"的状态;
// 空态自带主提示与按钮, 再压一条提示只会重复
const hint = computed(() => {
    if (isCamera.value) {
        if (cameraPreview.value) return t('cameraPausedHint');
        if (!cameraActive.value && !cameraStarting.value) return t('cameraOffHint');
        return t('cameraHint');
    }
    return previewUrl.value ? t('previewHint') : '';
});

// 面板里没有底部操作行, 所有功能按钮都在标题栏右侧, 用图标 + title/aria-label 说明
type PanelAction = {
    icon: 'stop' | 'resume' | 'camera' | 'scan';
    label: string;
    primary?: boolean;
    disabled?: boolean;
    run: () => void;
};

const actions = computed<PanelAction[]>(() => {
    if (isCamera.value) {
        if (cameraActive.value) return [{ icon: 'stop', label: t('cameraStop'), run: stopCamera }];
        if (cameraPreview.value) {
            return [{ icon: 'resume', label: t('cameraResume'), primary: true, run: startCamera }];
        }
        return [{
            icon: 'camera',
            label: t('retryCamera'),
            primary: true,
            disabled: cameraStarting.value,
            run: startCamera,
        }];
    }
    // 图片的取图与清除在同一个位置随状态切换, 扫描单独一个按钮
    return [{
        icon: 'scan',
        label: t('scanNow'),
        primary: true,
        disabled: !previewUrl.value || recognizing.value,
        run: () => void scanLocalImage(),
    }];
});

// 清掉预览图后绿点没有可标的区域
function clearImage() {
    clear();
    codePicker.clear();
}

// 恢复摄像头后画面在动, 原来的绿点已经没有意义
watch(cameraActive, (active) => {
    if (active) codePicker.clear();
});

// 宿主改源时同步摄像头: 离开立即释放, 进入时等 video 渲染出来再请求
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
                        <!-- 摄像头: 有第二颗摄像头时才能翻转; 图片: 没图时上传, 有图时清除 -->
                        <button
                            v-if="isCamera && cameraCanFlip"
                            class="qr-scan-tool"
                            type="button"
                            :title="t('switchCamera')"
                            :aria-label="t('switchCamera')"
                            :disabled="cameraStarting"
                            @click="flipCamera"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M20.4 9A8.6 8.6 0 0 0 5.6 5.6L3.5 7.7" />
                                <path d="M3.5 4.4v3.3h3.3" />
                                <path d="M3.6 15a8.6 8.6 0 0 0 14.8 3.4l2.1-2.1" />
                                <path d="M20.5 19.6v-3.3h-3.3" />
                            </svg>
                        </button>
                        <button
                            v-else-if="!isCamera && previewUrl"
                            class="qr-scan-tool"
                            type="button"
                            :title="t('clearImage')"
                            :aria-label="t('clearImage')"
                            :disabled="recognizing"
                            @click="clearImage"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M4 7h16" />
                                <path d="M9.6 7V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2V7" />
                                <path d="m6.6 7 .8 11.6a1.2 1.2 0 0 0 1.2 1.1h6.8a1.2 1.2 0 0 0 1.2-1.1L17.4 7" />
                                <path d="M10.6 10.8v5M13.4 10.8v5" />
                            </svg>
                        </button>

                        <!-- 当前源的主要操作: 图片扫描, 相机的开启 / 停止 / 继续。
                             只有主操作带文字, 与一排图标按钮拉开层级 -->
                        <button
                            v-for="action in actions"
                            :key="action.icon"
                            class="qr-scan-tool"
                            :class="{ 'qr-scan-tool--primary': action.primary }"
                            type="button"
                            :title="action.label"
                            :aria-label="action.label"
                            :disabled="action.disabled"
                            @click="action.run"
                        >
                            <svg v-if="action.icon === 'stop'" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="7" y="7" width="10" height="10" rx="1.8" />
                            </svg>
                            <svg v-else-if="action.icon === 'resume'" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M9 7.3v9.4l7.4-4.7z" />
                            </svg>
                            <svg v-else-if="action.icon === 'camera'" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M4.4 8.2 5.5 6.6A1 1 0 0 1 6.3 6h3.4a1 1 0 0 1 .8.6l1.1 1.6" />
                                <rect x="2" y="8.2" width="20" height="11.8" rx="2.4" />
                                <circle cx="12" cy="14.1" r="3.4" />
                            </svg>
                            <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M4 9V6.6A2.6 2.6 0 0 1 6.6 4H9" />
                                <path d="M15 4h2.4A2.6 2.6 0 0 1 20 6.6V9" />
                                <path d="M20 15v2.4a2.6 2.6 0 0 1-2.6 2.6H15" />
                                <path d="M9 20H6.6A2.6 2.6 0 0 1 4 17.4V15" />
                                <path d="M4 12h16" />
                            </svg>
                            <span v-if="action.primary" class="qr-scan-tool-label">{{ action.label }}</span>
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
                    :style="stageStyle"
                >
                    <template v-if="isCamera">
                        <video
                            v-show="!cameraPreview"
                            ref="video"
                            class="qr-scan-media"
                            :class="{ 'qr-scan-media--mirror': cameraMirrored }"
                            muted
                            playsinline
                        ></video>
                        <img
                            v-if="cameraPreview"
                            class="qr-scan-media"
                            :class="{ 'qr-scan-media--mirror': cameraMirrored }"
                            :src="cameraPreview"
                            alt=""
                        />
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

                    <!-- 提示只在画面已经存在时出现, 空态的说明与按钮在取图区里 -->
                    <p v-if="hint" class="qr-scan-stage-hint">{{ hint }}</p>
                </div>
            </section>
        </div>
        <ScanMarks :rects="marks" :picked="pickedFlags" @pick="pickMark" @dismiss="clearMarks" />
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
    /* 窄屏下限: 面板不跟着容器无限收窄, 标题与右上角图标按钮才有呼吸空间;
       下限必须是绝对值, 用 100% 会跟着容器一起缩, 起不到撑住的作用。
       但手机上容器本身比 360px 还窄时再撑就会横向溢出, 取两者更小值 */
    min-width: min(360px, 100%);
    padding: clamp(16px, 4vw, 24px);
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

/* 浮层只负责承载遮罩，面板本体与独立页使用同一套规格 */
.qr-scan-panel--overlay {
    max-height: calc(100vh - 32px);
    overflow: auto;
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

/* 工具按钮: 细边框方块, 悬停转为品牌蓝, 只在需要时出现 */
.qr-scan-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #fff;
    color: #64748b;
    font: inherit;
    cursor: pointer;
    transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
}

.qr-scan-tool:hover:not(:disabled) {
    border-color: #bfdbfe;
    background: #f8fafc;
    color: #1d4ed8;
}

.qr-scan-tool:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 2px;
}

/* 扫描中不允许上传/翻转换图, 按钮保持可见但不可点 */
.qr-scan-tool:disabled {
    opacity: 0.45;
    cursor: default;
}

/* 主操作 (图片扫描 / 开启相机): 唯一带文字的实心按钮, 一眼能认出该点哪里 */
.qr-scan-tool--primary {
    padding: 0 12px;
    border-color: #2563eb;
    background: #2563eb;
    box-shadow: 0 6px 14px -8px rgba(37, 99, 235, 0.9);
    color: #fff;
}

.qr-scan-tool--primary:hover:not(:disabled) {
    border-color: #1d4ed8;
    background: #1d4ed8;
    color: #fff;
}

.qr-scan-tool--primary:active:not(:disabled) {
    transform: translateY(1px);
}

.qr-scan-tool--primary:disabled {
    border-color: #e2e8f0;
    background: #f1f5f9;
    box-shadow: none;
    /* 通用 disabled 会再压一层透明度, 主操作已经用中性配色表示不可点, 不需要更淡 */
    opacity: 1;
    color: #94a3b8;
}

.qr-scan-tool-label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
    white-space: nowrap;
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

/* 关闭按钮去掉边框, 与来源工具按钮区分层级 */
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
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 1.5px dashed #cbd5e1;
    border-radius: 10px;
    background: #fff;
    transition: border-color 150ms ease, background-color 150ms ease;
}

/* 窄屏上 16:9 只剩不到 200px, 空态的说明换行后会被裁掉;
   这时放弃固定比例, 让取景框按内容长高 (保留 min-height 撑住观感) */
@media (max-width: 420px) {
    .qr-scan-stage:not(.qr-scan-stage--camera) {
        aspect-ratio: auto;
        min-height: 210px;
    }
}

/* 虚线框同时是取图区的命中区域: 悬停与拖入时直接变品牌蓝,
   让"可以点"和"可以放"写在框上, 不用另加文字 */
.qr-scan-stage:has(.qr-picker:hover),
.qr-scan-stage:has(.qr-picker:focus-within) {
    border-color: #93c5fd;
    background: #fbfdff;
}

.qr-scan-stage:has(.qr-picker--active) {
    border-color: #2563eb;
    background: #eff6ff;
}

/* 摄像头取景框跟随画面比例, 高度封顶后再按同一比例收窄宽度,
   竖屏手机画面才不会把面板撑出窗口 */
.qr-scan-stage--camera {
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

/* 取图区占满取景框, 内容居中; 虚线边框正好充当取景提示 */
.qr-scan-stage .qr-picker {
    height: 100%;
    justify-content: center;
}

/* 提示压在取景框底部: 深色药丸在深色画面和浅色预览上都看得清, 不再挤占面板高度 */
.qr-scan-stage-hint {
    position: absolute;
    left: 50%;
    bottom: 10px;
    box-sizing: border-box;
    max-width: calc(100% - 24px);
    margin: 0;
    padding: 4px 11px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.72);
    backdrop-filter: blur(6px);
    color: #f8fafc;
    font-size: 12px;
    line-height: 17px;
    text-align: center;
    white-space: nowrap;
    text-overflow: ellipsis;
    transform: translateX(-50%);
    pointer-events: none;
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

/* 摄像头未开启: 图标 + 一句说明填满浅色取景框 */
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
