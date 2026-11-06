import { ref } from 'vue';
import { useCameraScan } from '@/composables/useCameraScan';
import { errorNotice } from '@/services/decodeResultNotice';
import { t } from '@/services/i18n';
import type { PopupNoticePayload } from '@/services/popupNotice';

type CameraScanPanelOptions = {
    notify: (payload: PopupNoticePayload) => Promise<unknown>;
    runScan: (loader: () => Promise<ImageData>, errorTitle: string) => Promise<void>;
};

// 摄像头源: 设备生命周期、画面状态与错误提示都在这里, 命中的帧交回统一扫描流水线。
// 组件卸载时 useCameraScan 会释放设备, 因此不需要外部开关。
export function useCameraScanPanel(options: CameraScanPanelOptions) {
    const video = ref<HTMLVideoElement | null>(null);

    async function handleCameraError(error: unknown) {
        await options.notify(errorNotice(t('cameraFailed'), describeCameraError(error)));
    }

    const scan = useCameraScan({
        video,
        onFrame: (frame) => options.runScan(async () => frame, t('cameraFailed')),
        onError: handleCameraError,
    });

    return { video, ...scan };
}

function describeCameraError(error: unknown): string {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return t('cameraPermissionDenied');
    if (name === 'NotFoundError') return t('cameraNotFound');
    if (name === 'NotReadableError' || name === 'AbortError') return t('cameraBusy');
    return error instanceof Error ? error.message : String(error);
}
