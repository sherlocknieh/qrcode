import qrcode from 'qrcode-generator';

// 默认按 Latin-1 取字节, 统一改成 UTF-8 才能正确编码中文
qrcode.stringToBytes = (text: string) => Array.from(new TextEncoder().encode(text));

const CELL_SIZE = 8;    // 每个模块的像素大小
const QUIET_ZONE = 2;   // 白边宽度(模块数), 深色背景下也能扫描

// 只有一份编码结果, 预览与下载共用, 各种输出格式的模块数与容错级别才不会分叉
function encodeQrCode(text: string) {
    const qr = qrcode(0, 'M'); // 尺寸自动, 容错级别中等
    qr.addData(text);
    qr.make();
    return qr;
}

// 二维码唯一的生成入口: 预览与下载都基于这份矢量图, 不再各画一遍矩阵.
// 白底画进矢量图本身: 深色主题或自动暗色下, 透明码面会与背景糊成一片;
// viewBox 用模块单位并配合 crispEdges, 放大到印刷尺寸也不会出现模糊间隙
export function createQrCodeSvg(text: string): string {
    const qr = encodeQrCode(text);
    const moduleCount = qr.getModuleCount();
    const size = moduleCount + QUIET_ZONE * 2;
    const pixelSize = size * CELL_SIZE;

    let path = '';
    for (let row = 0; row < moduleCount; row++) {
        for (let col = 0; col < moduleCount; col++) {
            if (!qr.isDark(row, col)) continue;
            path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
        }
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" ` +
        `viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
        `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
        `<path fill="#000000" d="${path}"/></svg>`
    );
}

// 预览直接显示这条 data URL, 不必先光栅化
export function toSvgDataUrl(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// 下载 PNG 时才光栅化: 由同一份 SVG 按模块像素尺寸出图, 白底已在矢量图里
export async function svgToPngDataUrl(svg: string): Promise<string> {
    const image = new Image();
    image.src = toSvgDataUrl(svg);
    await image.decode();

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available.');

    ctx.drawImage(image, 0, 0);

    return canvas.toDataURL('image/png');
}
