import { nextTick } from 'vue';
import { useImageSource } from '@/composables/useImageSource';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import type { PopupNoticePayload } from '@/services/popupNotice';

type ImageScanPanelOptions = {
    isBusy: () => boolean;
    notify: (payload: PopupNoticePayload) => Promise<unknown>;
    runScan: (loader: () => Promise<ImageData>, errorTitle: string) => Promise<void>;
};

// 图片源: 取图、预览与触发扫描都在这里, 不参与结果展示。
export function useImageScanPanel(options: ImageScanPanelOptions) {
    const { previewUrl, loadBlob, clear } = useImageSource({ notify: options.notify });

    async function handleFile(blob: Blob) {
        if (options.isBusy() || !(await loadBlob(blob))) return;
        // 预览先渲染出来, 扫描动画才能定位到图片区域
        await nextTick();
        await scan();
    }

    function scan() {
        if (!previewUrl.value || options.isBusy()) return;
        return options.runScan(
            () => getImageDataFromDataUrl(previewUrl.value),
            t('imageFetchFailed'),
        );
    }

    function clearImage() {
        clear();
    }

    return { previewUrl, handleFile, scan, clearImage };
}
