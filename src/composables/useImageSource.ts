import { ref } from 'vue';
import { blobToDataUrl } from '@/services/clipboardImage';
import { describeImageError, errorNotice } from '@/services/decodeResultNotice';
import type { PopupNoticePayload } from '@/services/popupNotice';
import { t } from '@/services/i18n';

// 图片取图源: 只负责把用户选择/粘贴/拖入的图片变成预览,
// 扫描统一交给 ScanPanel 的 recognizeImage 流水线, 与摄像头源保持同构。
type ImageSourceOptions = {
    // 取图阶段 (Blob → DataURL) 失败时的提示
    notify: (payload: PopupNoticePayload) => Promise<unknown>;
    errorTitle?: string;
};

export function useImageSource(options: ImageSourceOptions) {
    const previewUrl = ref('');

    // 返回 false 表示取图失败, 调用方不应继续扫描
    async function loadBlob(blob: Blob): Promise<boolean> {
        try {
            previewUrl.value = await blobToDataUrl(blob);
            return true;
        } catch (error) {
            await options.notify(errorNotice(
                options.errorTitle ?? t('imageFetchFailed'),
                describeImageError(error),
            ));
            return false;
        }
    }

    // 清空已选图片, 回到初始取图状态
    function clear() {
        previewUrl.value = '';
    }

    return { previewUrl, loadBlob, clear };
}
