<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useCameraScan } from '@/composables/useCameraScan';
import { useNoticeFallback } from '@/composables/useNoticeFallback';
import { errorNotice } from '@/services/decodeResultNotice';
import { t } from '@/services/i18n';

// 摄像头扫码面板: 只在独立识别页 (upload.html?camera=1) 使用。
// 摄像头必须运行在扩展页面里: popup 会因失焦关闭, 内容脚本则受页面自身的摄像头权限约束。
const emit = defineEmits<{ (event: 'switch-mode'): void }>();

const video = ref<HTMLVideoElement | null>(null);
const { host } = useNoticeFallback();

// 把浏览器抛出的设备错误翻译成用户能理解的文案
function describeCameraError(error: unknown): string {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return t('cameraPermissionDenied');
    if (name === 'NotFoundError') return t('cameraNotFound');
    if (name === 'NotReadableError' || name === 'AbortError') return t('cameraBusy');
    return error instanceof Error ? error.message : String(error);
}

const { active, starting, previewUrl, start, stop, resume } = useCameraScan({
    video,
    // 结果通知复用现有策略: popup 优先, 页面内 NotifyHost 兜底
    onResults: (results) => host.notifyResults(results),
    onError: (error) => host.notify(errorNotice(t('cameraFailed'), describeCameraError(error))),
});

// 用户是从"摄像头扫码"入口进来的, 挂载后直接请求摄像头
onMounted(() => {
    void start();
});
</script>

<template>
    <section class="qr-camera-panel">
        <header class="qr-camera-header">
            <h1 class="qr-camera-title">{{ t('cameraScanTitle') }}</h1>
        </header>

        <div class="qr-camera-stage">
            <video
                v-show="!previewUrl"
                ref="video"
                class="qr-camera-media"
                muted
                playsinline
            ></video>
            <img v-if="previewUrl" class="qr-camera-media" :src="previewUrl" alt="" />
            <div v-if="active" class="qr-camera-frame" aria-hidden="true"></div>
            <p v-if="starting" class="qr-camera-state">{{ t('cameraStarting') }}</p>
        </div>

        <p class="qr-camera-hint">
            {{ previewUrl ? t('cameraPausedHint') : t('cameraHint') }}
        </p>

        <div class="qr-camera-actions">
            <button
                v-if="active"
                type="button"
                class="qr-camera-btn"
                @click="stop"
            >{{ t('cameraStop') }}</button>
            <button
                v-else-if="previewUrl"
                type="button"
                class="qr-camera-btn qr-camera-btn--primary"
                @click="resume"
            >{{ t('cameraResume') }}</button>
            <button
                v-else
                type="button"
                class="qr-camera-btn qr-camera-btn--primary"
                :disabled="starting"
                @click="start"
            >{{ t('retryCamera') }}</button>

            <button
                type="button"
                class="qr-camera-btn"
                @click="emit('switch-mode')"
            >{{ t('switchToImageScan') }}</button>
        </div>
    </section>
</template>

<style scoped>
.qr-camera-panel {
    box-sizing: border-box;
    width: min(560px, 100%);
    padding: 28px;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    background: #fff;
    box-shadow: 0 12px 40px rgba(15, 23, 42, 0.08);
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
    color: #1f2937;
}

.qr-camera-header {
    margin-bottom: 20px;
    text-align: center;
}

.qr-camera-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: #0f172a;
}

.qr-camera-stage {
    position: relative;
    overflow: hidden;
    aspect-ratio: 4 / 3;
    border-radius: 12px;
    background: #0f172a;
}

.qr-camera-media {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
}

/* 取景框只是视觉引导, 不参与点击 */
.qr-camera-frame {
    position: absolute;
    inset: 12%;
    border: 2px dashed rgba(255, 255, 255, 0.85);
    border-radius: 12px;
    pointer-events: none;
}

.qr-camera-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    background: rgba(15, 23, 42, 0.55);
    color: #f8fafc;
    font-size: 14px;
}

.qr-camera-hint {
    margin: 14px 0 0;
    text-align: center;
    font-size: 14px;
    color: #64748b;
}

.qr-camera-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
}

.qr-camera-btn {
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

.qr-camera-btn:hover:not(:disabled) {
    background: #f8fafc;
    border-color: #94a3b8;
}

.qr-camera-btn--primary {
    border-color: #2cabff;
    background: #2cabff;
    color: #fff;
}

.qr-camera-btn--primary:hover:not(:disabled) {
    border-color: #1b9be9;
    background: #1b9be9;
}

.qr-camera-btn:disabled {
    opacity: 0.6;
    cursor: default;
}
</style>
