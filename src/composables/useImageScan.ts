import { ref } from 'vue';
import { useNoticeFallback, type NoticeFallbackOptions } from '@/composables/useNoticeFallback';
import { blobToDataUrl } from '@/services/clipboardImage';
import { errorNotice } from '@/services/decodeResultNotice';
import { getImageDataFromDataUrl } from '@/services/qrScanner';
import { recognizeImage } from '@/services/recognize';
import { t } from '@/services/i18n';

type ImageScanOptions = {
    // 错误提示标题, 默认按图片加载失败处理
    errorTitle?: string;
    // 解码前播放的动画 (capture 直出模式的整屏扫描), 需返回 Promise 以便等待结束
    beforeNotice?: () => Promise<void>;
    // 解码结束 (含失败) 时回调, 通常用于停止动画
    afterDecode?: () => void;
    // 未识别到码时点击"尝试截图识别"的处理
    onRetry?: () => void;
    // 通知策略透传, 供独立识别页控制通知结束后的行为
    notice?: NoticeFallbackOptions;
};

// 图片识别的完整流程: 预览 → 加载提示 → 解码 → 结果/无结果/错误。
// 页面内浮层、独立识别页、capture 页共用同一份实现, 各自只负责承载 UI。
export function useImageScan(options: ImageScanOptions = {}) {
    const { host, notify } = useNoticeFallback(options.notice);

    const busy = ref(false);
    const previewUrl = ref('');

    // 拿到图片数据后的识别流程统一交给 recognizeImage
    function scan(dataUrl: string) {
        return recognizeImage(() => getImageDataFromDataUrl(dataUrl), {
            host,
            errorTitle: options.errorTitle,
            beforeNotice: options.beforeNotice,
            afterDecode: options.afterDecode,
            onRetry: options.onRetry,
        });
    }

    // 选中/粘贴/拖入图片: 只转换成预览, 由用户确认后再识别
    async function loadBlob(blob: Blob): Promise<void> {
        try {
            previewUrl.value = await blobToDataUrl(blob);
        } catch (error) {
            await notify(
                errorNotice(
                    options.errorTitle ?? t('imageFetchFailed'),
                    error instanceof Error ? error.message : String(error),
                ),
            );
        }
    }

    // 识别当前预览的图片
    async function scanPreview(): Promise<void> {
        if (busy.value || !previewUrl.value) return;
        busy.value = true;
        try {
            await scan(previewUrl.value);
        } finally {
            busy.value = false;
        }
    }

    // 清空已选图片, 回到初始取图状态
    function clear() {
        if (busy.value) return;
        previewUrl.value = '';
    }

    return { busy, previewUrl, scan, loadBlob, scanPreview, clear };
}

export type { ImageScanOptions };
