<script lang="ts" setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import ImagePicker from '@/components/ImagePicker.vue';
import { useImageScan } from '@/composables/useImageScan';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { trySendMessage } from '@/services/messaging';
import { t } from '@/services/i18n';

// 图片识别面板: 页面内浮层与独立识别页共用同一份取图/预览/解码/通知逻辑,
// 只有外壳 (遮罩 vs 整页) 由调用方提供
const props = withDefaults(defineProps<{ variant?: 'page' | 'overlay' }>(), { variant: 'page' });

const emit = defineEmits<{ (event: 'close'): void }>();

const overlay = props.variant === 'overlay';

const pickerRef = ref<HTMLElement | null>(null);
const scanAnimation = useScanAnimation();

// 与"图片上右键识别"保持一致: 先预览图上播放扫描动画, 动画结束再弹出识别结果
async function playPreviewAnimation() {
    const image = pickerRef.value?.querySelector<HTMLImageElement>('.qr-picker-preview');
    if (!image) return;
    const rect = image.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    await scanAnimation.play({ rect });
}

const { busy, previewUrl, loadBlob, scanPreview, clear } = useImageScan({
    beforeNotice: playPreviewAnimation,
    afterDecode: () => scanAnimation.stop(),
    // 未识别到码时点击"尝试截图识别", 交给后台按当前页面重新截图
    onRetry: () => void trySendMessage('requestScreenshot'),
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
    scanAnimation.stop();
});
</script>

<template>
    <!-- 浮层宿主: Teleport 到 body 并自带遮罩; 独立页宿主: 原地渲染, 由页面负责居中 -->
    <Teleport to="body" :disabled="!overlay">
        <div :class="overlay ? 'qr-scan-backdrop' : 'qr-scan-wrap'" @click.self="overlay && emit('close')">
            <section class="qr-scan-panel" :class="{ 'qr-scan-panel--overlay': overlay }" role="dialog" :aria-modal="overlay ? 'true' : undefined">
                <button
                    v-if="overlay"
                    class="qr-scan-panel-close"
                    type="button"
                    :aria-label="t('closeBtn')"
                    @click="emit('close')"
                >×</button>

                <header class="qr-scan-panel-header">
                    <component :is="overlay ? 'p' : 'h1'" class="qr-scan-panel-title">
                        {{ t('scanImageTitle') }}
                    </component>
                    <p v-if="!overlay" class="qr-scan-panel-desc">{{ t('scanImageDesc') }}</p>
                </header>

                <div ref="pickerRef">
                    <ImagePicker
                        :preview-url="previewUrl"
                        :busy="busy"
                        :variant="overlay ? 'overlay' : 'page'"
                        @file="loadBlob"
                        @close="emit('close')"
                    />
                </div>

                <!-- 选中图片后才出现操作按钮: 清空重新选择, 或确认识别 -->
                <div v-if="previewUrl" class="qr-scan-panel-actions">
                    <button
                        type="button"
                        class="qr-scan-panel-btn"
                        :disabled="busy"
                        @click="clear"
                    >{{ t('clearImage') }}</button>
                    <button
                        type="button"
                        class="qr-scan-panel-btn qr-scan-panel-btn--primary"
                        :disabled="busy"
                        @click="scanPreview"
                    >{{ t('scanNow') }}</button>
                </div>
            </section>
        </div>
    </Teleport>
</template>

<style scoped>
.qr-scan-wrap {
    display: contents;
}

/* 浮层宿主: 覆盖页面并居中面板 */
.qr-scan-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(8, 12, 20, 0.32);
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
    width: min(420px, 100%);
    padding: 28px;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #1f2937;
}

/* 浮层里没有页面边距, 需要自己限制最大宽度并收紧留白;
   小窗口下允许面板内部滚动, 避免整体溢出视口 */
.qr-scan-panel--overlay {
    width: min(420px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 20px;
    border-color: transparent;
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(15, 23, 42, 0.24);
}

.qr-scan-panel-close {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #64748b;
    cursor: pointer;
    font: 18px/22px Arial, sans-serif;
    transition: background-color 120ms ease, color 120ms ease;
}

.qr-scan-panel-close:hover {
    background: #f1f5f9;
    color: #0f172a;
}

.qr-scan-panel-header {
    margin-bottom: 20px;
    text-align: center;
}

.qr-scan-panel-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: #0f172a;
}

.qr-scan-panel-desc {
    margin: 8px 0 0;
    font-size: 14px;
    line-height: 1.6;
    color: #64748b;
}

.qr-scan-panel-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
}

.qr-scan-panel-btn {
    flex: 1 1 0;
    padding: 9px 16px;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #fff;
    color: #0f172a;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
}

.qr-scan-panel-btn:hover:not(:disabled) {
    background: #f8fafc;
    border-color: #94a3b8;
}

.qr-scan-panel-btn--primary {
    border-color: #2cabff;
    background: #2cabff;
    color: #fff;
}

.qr-scan-panel-btn--primary:hover:not(:disabled) {
    border-color: #1b9be9;
    background: #1b9be9;
}

.qr-scan-panel-btn:disabled {
    opacity: 0.6;
    cursor: default;
}

/* 浮层空间更紧凑: 标题缩小并让出关闭按钮的位置 */
.qr-scan-panel--overlay .qr-scan-panel-header {
    margin-bottom: 12px;
}

.qr-scan-panel--overlay .qr-scan-panel-title {
    padding-right: 24px;
    font-size: 15px;
}
</style>
