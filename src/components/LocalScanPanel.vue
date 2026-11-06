<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
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
// 各源的状态、取景框与按钮都收在自己的区域组件里, 面板只负责切源、统一识别与结果展示。
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
    <section class="qr-scan-panel" aria-labelledby="qr-scan-panel-title">
        <header class="qr-scan-panel-header">
            <h1 id="qr-scan-panel-title" class="qr-scan-panel-title">
                {{ t(isCamera ? 'scanCamera' : 'scanLocalImageTitle') }}
            </h1>
            <!-- 面板内的两个源: 相机是默认入口, 图片是相机不可用或被拒绝时的退路 -->
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
                    {{ t('qrActionCamera') }}
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
                        <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
                        <path d="M12 15.6V8.6" />
                        <path d="m8.8 11.6 3.2-3 3.2 3" />
                    </svg>
                    {{ t('qrActionImage') }}
                </button>
            </div>
        </header>

        <!-- 取景框: 各自组件自带画面、操作与提示 -->
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

/* 标题栏: 标题左对齐, 源切换收在右侧, 高度固定 */
.qr-scan-panel-header {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 32px;
    margin-bottom: 12px;
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

/* 源切换: 两个并列选项, 选中项浮白底; 相机与图片是同一面板的两种取图方式 */
.qr-scan-source {
    display: inline-flex;
    flex: none;
    gap: 2px;
    padding: 3px;
    border-radius: 11px;
    background: #f1f5f9;
}

.qr-scan-source-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: #64748b;
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
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

/* 当前源的操作贴在取景框底部, 不占用标题栏空间 */
:deep(.qr-scan-stage-tools) {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 4px 14px rgba(15, 23, 42, 0.16);
}

/* 工具按钮: 细边框方块, 悬停转为品牌蓝, 只在需要时出现 */
:deep(.qr-scan-tool) {
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

:deep(.qr-scan-tool:hover:not(:disabled)) {
    border-color: #bfdbfe;
    background: #f8fafc;
    color: #1d4ed8;
}

:deep(.qr-scan-tool:focus-visible) {
    outline: 2px solid rgba(37, 99, 235, 0.35);
    outline-offset: 2px;
}

/* 扫描中不允许上传/翻转换图, 按钮保持可见但不可点 */
:deep(.qr-scan-tool:disabled) {
    opacity: 0.45;
    cursor: default;
}

/* 主操作 (图片扫描 / 继续相机): 唯一带文字的实心按钮, 一眼能认出该点哪里 */
:deep(.qr-scan-tool--primary) {
    padding: 0 12px;
    border-color: #2563eb;
    background: #2563eb;
    box-shadow: 0 6px 14px -8px rgba(37, 99, 235, 0.9);
    color: #fff;
}

:deep(.qr-scan-tool--primary:hover:not(:disabled)) {
    border-color: #1d4ed8;
    background: #1d4ed8;
    color: #fff;
}

:deep(.qr-scan-tool--primary:active:not(:disabled)) {
    transform: translateY(1px);
}

:deep(.qr-scan-tool--primary:disabled) {
    border-color: #e2e8f0;
    background: #f1f5f9;
    box-shadow: none;
    /* 通用 disabled 会再压一层透明度, 主操作已经用中性配色表示不可点, 不需要更淡 */
    opacity: 1;
    color: #94a3b8;
}

:deep(.qr-scan-tool-label) {
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
    white-space: nowrap;
}

/* 完整声明 margin/opacity: 页面全局 svg 规则会作用到注入的浮层上 */
:deep(.qr-scan-tool svg) {
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
