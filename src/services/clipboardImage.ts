// 剪贴板图片处理: 不使用 clipboardRead 权限, 图片只从 paste/拖放事件中取得。

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

// 复制二维码等图片到剪贴板: 不使用 clipboardWrite 权限,
// Clipboard API 的写入发生在点击手势里, 不支持图片写入时返回 false
export async function copyImageDataUrl(dataUrl: string): Promise<boolean> {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const [head, base64] = dataUrl.split(',');
    const type = head?.match(/^data:(.*?);/)?.[1] ?? 'image/png';
    if (!base64) return false;
    try {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        await navigator.clipboard.write([
            new ClipboardItem({ [type]: new Blob([bytes], { type }) }),
        ]);
        return true;
    } catch {
        return false;
    }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Read failed.'));
        reader.readAsDataURL(blob);
    });
}
