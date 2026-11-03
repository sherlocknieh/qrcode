import qrcode from 'qrcode-generator';

// 默认按 Latin-1 取字节, 统一改成 UTF-8 才能正确编码中文
qrcode.stringToBytes = (text: string) => Array.from(new TextEncoder().encode(text));

export interface QrCodeImage {
    dataUrl: string;
    moduleCount: number;
}

const CELL_SIZE = 8;    // 每个模块的像素大小
const QUIET_ZONE = 2;   // 白边宽度(模块数), 深色背景下也能扫描

// 生成二维码 PNG, 供 popup 与独立生成页共用
export function createQrCodeImage(text: string): QrCodeImage {
    const qr = qrcode(0, 'M'); // 尺寸自动, 容错级别中等
    qr.addData(text);
    qr.make();

    const moduleCount = qr.getModuleCount();
    const margin = CELL_SIZE * QUIET_ZONE;
    const totalSize = moduleCount * CELL_SIZE + margin * 2;

    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalSize, totalSize);

    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
            if (!qr.isDark(row, col)) continue;
            ctx.fillRect(margin + col * CELL_SIZE, margin + row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
    }

    return { dataUrl: canvas.toDataURL('image/png'), moduleCount };
}
