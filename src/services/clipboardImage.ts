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

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Read failed.'));
        reader.readAsDataURL(blob);
    });
}
