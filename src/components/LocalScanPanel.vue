<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, ref, watchEffect } from 'vue';
import CameraScanArea from '@/components/CameraScanArea.vue';
import ImageScanArea from '@/components/ImageScanArea.vue';
import ScanResultMarks from '@/components/ScanResultMarks.vue';
import type { ScanRect } from '@/components/ScanAnimation.vue';
import { useCodePicker } from '@/composables/useCodePicker';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { recognizeImage } from '@/services/recognize';
import { t } from '@/services/i18n';

// 扫描面板: 相机与本地图片是同一条扫描流水线 (recognizeImage) 的两种输入源。
// 各源的状态与取景框收在自己的区域组件里, 操作按钮由标题栏统一渲染, 面板负责切源、统一识别与结果展示。
type ScanMode = 'image' | 'camera';

const props = withDefaults(
    defineProps<{
        // 进入面板时选中的源, 之后由面板内的切换控制
        mode?: ScanMode;
    }>(),
    { mode: 'camera' },
);

const mode = ref<ScanMode>(props.mode);
const isCamera = computed(() => mode.value === 'camera');

const { host, notify, notifyPickedResults, notifyResults } = useNoticeFallback();
const scanAnimation = useScanAnimation();
const recognizing = ref(false);
// 与其它入口一致: 命中码后在预览图上叠绿点, 点哪个就把通知切到哪个码
const codePicker = useCodePicker({ notifyResults });
const marks = codePicker.marks;
const pickedFlags = codePicker.pickedFlags;
const pickMark = codePicker.pick;
const clearMarks = codePicker.clear;
// 点已看过的灰框(或单码框)与点空白同一个收尾
const dismissMarks = codePicker.dismiss;

// 当前源自己知道画面画在哪里: 面板只问它要区域, 不关心是视频还是预览图
type ScanArea = {
    measure: () => Promise<ScanRect | undefined>;
    measureResult: () => ScanRect | undefined;
    isMirrored?: () => boolean;
};

const cameraArea = ref<InstanceType<typeof CameraScanArea> | null>(null);
const imageArea = ref<InstanceType<typeof ImageScanArea> | null>(null);
const activeArea = computed<ScanArea | null>(() => (isCamera.value ? cameraArea.value : imageArea.value));

// ---------------------------- 共用扫描流水线 ----------------------------

async function runScan(loader: () => Promise<ImageData>, errorTitle = '') {
    if (recognizing.value) return;
    recognizing.value = true;
    codePicker.clear();
    try {
        const outcome = await recognizeImage(loader, {
            host,
            errorTitle,
            beforeNotice: playScanAnimation,
            afterDecode: () => scanAnimation.stop(),
            // 结果通知与绿点同时给出, 由这里统一处理
            deferResults: true,
        });
        if (outcome.status !== 'ok') return;
        // 命中后画面会切到暂停帧, 等它渲染出来再量区域
        await nextTick();
        const rect = activeArea.value?.measureResult();
        if (rect) {
            codePicker.show(outcome.results, {
                rect,
                imageSize: outcome.imageSize,
                scroll: { x: window.scrollX, y: window.scrollY },
                viewportWidth: window.innerWidth,
                // 绿框跟着卡片一起随页面滚动
                followScroll: true,
                // 画面镜像显示时才需要翻转横向坐标才能压住码
                mirrorX: activeArea.value?.isMirrored?.() ?? false,
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

// 扫描动画由当前源给出区域: 视频盖取景框, 图片贴合图片本身
async function playScanAnimation() {
    const rect = await activeArea.value?.measure();
    if (!rect) return;
    await scanAnimation.play({ rect });
}

// ---------------------------- 布局与交互 ----------------------------

// 标签页标题跟随当前源, 与面板内的标签文案一致
watchEffect(() => {
    document.title = t(isCamera.value ? 'scanCameraTitle' : 'scanLocalImageTitle');
});

// 面板内切源: 组件卸载会带走各自设备与预览, 这里只清掉旧结果
function switchMode(next: ScanMode) {
    if (mode.value === next) return;
    mode.value = next;
    codePicker.clear();
}

onBeforeUnmount(() => {
    void scanAnimation.stop();
});
</script>

<template>
    <section class="qr-scan-panel">
        <header class="qr-scan-panel-header">
            <!-- 源切换: 每个标签直接写明对应的扫描标题 -->
            <div class="qr-scan-source" role="tablist" :aria-label="t('scanSource')">
                <button
                    class="qr-scan-source-item"
                    :class="{ 'qr-scan-source-item--active': isCamera }"
                    type="button"
                    role="tab"
                    :aria-selected="isCamera"
                    @click="switchMode('camera')"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4.4 8.2 5.5 6.6A1 1 0 0 1 6.3 6h3.4a1 1 0 0 1 .8.6l1.1 1.6" />
                        <rect x="2" y="8.2" width="20" height="11.8" rx="2.4" />
                        <circle cx="12" cy="14.1" r="3.4" />
                    </svg>
                    <span class="qr-scan-source-label">{{ t('scanCameraTitle') }}</span>
                </button>
                <button
                    class="qr-scan-source-item"
                    :class="{ 'qr-scan-source-item--active': !isCamera }"
                    type="button"
                    role="tab"
                    :aria-selected="!isCamera"
                    @click="switchMode('image')"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4" />
                        <circle cx="8.4" cy="9.6" r="1.3" />
                        <path d="m4.4 17.8 5-5 3.3 3.3 2.2-2.2 4.9 4.9" />
                    </svg>
                    <span class="qr-scan-source-label">{{ t('scanLocalImageTitle') }}</span>
                </button>
            </div>
            <!-- 相机操作: 播放/暂停常驻开关, 另有翻转 -->
            <div v-if="isCamera" class="qr-scan-actions">
                <button
                    class="qr-scan-tool"
                    type="button"
                    :title="t(cameraArea?.active ? 'cameraClose' : 'retryCamera')"
                    :aria-label="t(cameraArea?.active ? 'cameraClose' : 'retryCamera')"
                    :disabled="cameraArea?.starting"
                    @click="cameraArea?.active ? cameraArea?.stop() : cameraArea?.start()"
                >
                    <!-- 取景中显示暂停, 关着时显示播放 -->
                    <svg v-if="cameraArea?.active" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="8" y="6.5" width="2.6" height="11" rx="1.2" />
                        <rect x="13.4" y="6.5" width="2.6" height="11" rx="1.2" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9 7.3v9.4l7.4-4.7z" />
                    </svg>
                </button>
                <button
                    v-if="cameraArea?.canFlip"
                    class="qr-scan-tool"
                    type="button"
                    :title="t('switchCamera')"
                    :aria-label="t('switchCamera')"
                    :disabled="cameraArea?.starting"
                    @click="cameraArea?.flip()"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M20.4 9A8.6 8.6 0 0 0 5.6 5.6L3.5 7.7" />
                        <path d="M3.5 4.4v3.3h3.3" />
                        <path d="M3.6 15a8.6 8.6 0 0 0 14.8 3.4l2.1-2.1" />
                        <path d="M20.5 19.6v-3.3h-3.3" />
                    </svg>
                </button>
            </div>
            <!-- 图片操作: 上传 / 清空 -->
            <div v-else class="qr-scan-actions">
                <button
                    class="qr-scan-tool"
                    type="button"
                    :title="t('chooseImage')"
                    :aria-label="t('chooseImage')"
                    :disabled="recognizing"
                    @click="imageArea?.pickFile()"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 15.4V4.8" />
                        <path d="m7.8 9 4.2-4.2L16.2 9" />
                        <path d="M4.6 15.4v2.4a2.4 2.4 0 0 0 2.4 2.4h10a2.4 2.4 0 0 0 2.4-2.4v-2.4" />
                    </svg>
                </button>
                <button
                    v-if="imageArea?.previewUrl"
                    class="qr-scan-tool"
                    type="button"
                    :title="t('clearImage')"
                    :aria-label="t('clearImage')"
                    :disabled="recognizing"
                    @click="imageArea?.clear()"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 7h16" />
                        <path d="M9.6 7V5.4a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2V7" />
                        <path d="m6.6 7 .8 11.6a1.2 1.2 0 0 0 1.2 1.1h6.8a1.2 1.2 0 0 0 1.2-1.1L17.4 7" />
                        <path d="M10.6 10.8v5M13.4 10.8v5" />
                    </svg>
                </button>
            </div>
        </header>

        <!-- 取景框: 各自组件自带画面与提示, 操作在标题栏 -->
        <CameraScanArea
            v-if="isCamera"
            ref="cameraArea"
            :notify="notify"
            :run-scan="runScan"
            @restarted="clearMarks"
        />
        <ImageScanArea
            v-else
            ref="imageArea"
            :busy="recognizing"
            :notify="notify"
            :run-scan="runScan"
            @cleared="clearMarks"
        />
    </section>

    <ScanResultMarks :rects="marks" :picked="pickedFlags" @pick="pickMark" @dismiss="dismissMarks" />
</template>

<style scoped>
.qr-scan-panel {
    position: relative;
    box-sizing: border-box;
    width: min(560px, 100%);
    /* 窄屏下限: 面板不跟着容器无限收窄, 源切换与右上角按钮才有呼吸空间;
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

/* 标题栏: 源切换靠左, 当前源的操作靠右; 窄屏放不下时操作另起一行 */
.qr-scan-panel-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    min-height: 32px;
    margin-bottom: 12px;
}

/* 源切换: 两个等宽选项, 选中项浮白底; 相机与图片是同一面板的两种取图方式 */
.qr-scan-source {
    display: inline-grid;
    /* 可压缩: 窄屏上两个标签的固有宽度会超过卡片内容区, 不缩就会顶出右边缘 */
    flex: 0 1 auto;
    grid-auto-flow: column;
    /* 1fr 让两格以较长的标签为准等宽, 切换时按钮不跳动 */
    grid-auto-columns: minmax(0, 1fr);
    gap: 2px;
    min-width: 0;
    padding: 3px;
    border-radius: 11px;
    background: #f1f5f9;
}

.qr-scan-source-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 28px;
    min-width: 0;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #64748b;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}

/* 标签文字是唯一可压缩的部分: 放不下时省略, 图标与内边距保持不动 */
.qr-scan-source-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 窄屏: 标题栏不换行, 切换器让出空间给右侧操作按钮;
   放不下时只省略标签文字, 按钮始终留在同一行 */
@media (max-width: 420px) {
    .qr-scan-panel-header {
        flex-wrap: nowrap;
        gap: 8px;
    }

    .qr-scan-source {
        flex: 1 1 auto;
        grid-auto-columns: minmax(0, auto);
    }

    .qr-scan-source-item {
        gap: 3px;
        padding: 0 3px;
        font-size: clamp(10px, 3.2vw, 12.5px);
    }
}

.qr-scan-source-item:hover {
    color: #1d4ed8;
}

.qr-scan-source-item--active {
    background: #fff;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.12);
    color: #1d4ed8;
    font-weight: 600;
}

.qr-scan-source-item:focus-visible {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 1px;
}

.qr-scan-source-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    margin: 0;
    opacity: 1;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

/* 取景框: 两个源共用同一个外观, 内部画面由各自组件决定 */
:deep(.qr-scan-stage) {
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
    :deep(.qr-scan-stage:not(.qr-scan-stage--camera)) {
        aspect-ratio: auto;
        min-height: 210px;
    }
}

/* 虚线框同时是取图区的命中区域: 悬停与拖入时直接变品牌蓝,
   让"可以点"和"可以放"写在框上, 不用另加文字 */
:deep(.qr-scan-stage:has(.qr-picker:hover)),
:deep(.qr-scan-stage:has(.qr-picker:focus-within)) {
    border-color: #93c5fd;
    background: #fbfdff;
}

:deep(.qr-scan-stage:has(.qr-picker--active)) {
    border-color: #2563eb;
    background: #eff6ff;
}

/* 当前源的操作放在标题栏右侧, 不遮挡取景框画面 */
.qr-scan-actions {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}

/* 工具按钮: 统一的 32px 细边框方块, 悬停转为品牌蓝 */
.qr-scan-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
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

@media (prefers-reduced-motion: reduce) {
    .qr-scan-panel {
        animation-duration: 1ms;
    }
}
</style>
