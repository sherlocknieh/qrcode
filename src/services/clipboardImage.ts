// 读取剪贴板中的图片, 供 popup 和独立识别页共用。

// 读取失败的原因: unsupported 表示浏览器没有提供 Clipboard.read,
// denied 表示用户或浏览器拒绝了读取权限。
export type ClipboardImageErrorReason = 'unsupported' | 'denied';

export class ClipboardImageError extends Error {
    constructor(readonly reason: ClipboardImageErrorReason) {
        super(reason);
        this.name = 'ClipboardImageError';
    }
}

// 返回剪贴板中的第一张图片; 没有图片时返回 null。
export async function readClipboardImage(): Promise<Blob | null> {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        throw new ClipboardImageError('unsupported');
    }

    let items: ClipboardItems;
    try {
        items = await navigator.clipboard.read();
    } catch {
        throw new ClipboardImageError('denied');
    }

    for (const item of items) {
        const type = item.types.find((value) => value.startsWith('image/'));
        if (!type) continue;
        try {
            return await item.getType(type);
        } catch {
            // 当前条目图片读取失败时继续尝试下一条
        }
    }

    return null;
}

// 从粘贴事件或拖放事件的数据中取出图片文件。
export function getImageFileFromDataTransfer(data: DataTransfer | null): File | null {
    if (!data) return null;

    for (const item of Array.from(data.items)) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) return file;
    }

    return null;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Read failed.'));
        reader.readAsDataURL(blob);
    });
}
