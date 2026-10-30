import { getImageDataFromDataUrl } from '@/services/qrScanner';

export type PreloadedImage =
    | { ok: true; imageData: ImageData }
    | { ok: false; error: unknown };

// 与扫描动画并行预读截图像素: 失败也先接住错误,
// 避免动画播放期间出现未处理的 Promise rejection
export function preloadImageData(dataUrl: string): Promise<PreloadedImage> {
    return getImageDataFromDataUrl(dataUrl).then(
        (imageData): PreloadedImage => ({ ok: true, imageData }),
        (error: unknown): PreloadedImage => ({ ok: false, error }),
    );
}
