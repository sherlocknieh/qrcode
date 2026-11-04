import BarcodeFormat from '@zxing/library/esm/core/BarcodeFormat';
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap';
import BitArray from '@zxing/library/esm/core/common/BitArray';
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType';
import type DetectorResult from '@zxing/library/esm/core/common/DetectorResult';
import GlobalHistogramBinarizer from '@zxing/library/esm/core/common/GlobalHistogramBinarizer';
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer';
import NotFoundException from '@zxing/library/esm/core/NotFoundException';
import Code128Reader from '@zxing/library/esm/core/oned/Code128Reader';
import Code39Reader from '@zxing/library/esm/core/oned/Code39Reader';
import Code93Reader from '@zxing/library/esm/core/oned/Code93Reader';
import ITFReader from '@zxing/library/esm/core/oned/ITFReader';
import MultiFormatUPCEANReader from '@zxing/library/esm/core/oned/MultiFormatUPCEANReader';
import OneDReader from '@zxing/library/esm/core/oned/OneDReader';
import PlanarYUVLuminanceSource from '@zxing/library/esm/core/PlanarYUVLuminanceSource';
import Decoder from '@zxing/library/esm/core/qrcode/decoder/Decoder';
import Detector from '@zxing/library/esm/core/qrcode/detector/Detector';
import type FinderPattern from '@zxing/library/esm/core/qrcode/detector/FinderPattern';
import FinderPatternFinder from '@zxing/library/esm/core/qrcode/detector/FinderPatternFinder';
import FinderPatternInfo from '@zxing/library/esm/core/qrcode/detector/FinderPatternInfo';
import QRCodeReader from '@zxing/library/esm/core/qrcode/QRCodeReader';
import Result from '@zxing/library/esm/core/Result';
import ResultPoint from '@zxing/library/esm/core/ResultPoint';
import type ResultPointCallback from '@zxing/library/esm/core/ResultPointCallback';

// SVG 提取像素时的目标尺寸上限，避免超大 SVG 生成大量候选图后占用过多内存。
const SVG_SCAN_DIMENSION = 512;

// 位图的目标扫描尺寸：小图（如聊天截图、缩略图）中的二维码模块往往只有几个像素，
// ZXing 难以定位；平滑放大后模块边缘更清晰，扫描率明显提升。
const RASTER_SCAN_DIMENSION = 1000;

// 位图的最大放大倍数。放大过多只会增加内存和耗时，扫描率不再提升。
const RASTER_MAX_UPSCALE = 4;

// 通过后台脚本获取跨域图片，并返回可供扫描器使用的 Data URL。
type ProxyFetcher = (url: string) => Promise<string>;

// 图片加载选项：可指定页面来源，以及跨域图片的代理获取函数。
type LoadImageOptions = {
    origin?: string;
    fetchViaProxy?: ProxyFetcher;
};

// 判断图片地址是否可以直接从当前页面读取。
// file、data 和 blob 地址需要单独处理，不能简单按普通 URL 判断来源。
export function isSameOrigin(url: string, origin: string): boolean {
    try {
        if (url.startsWith('data:') || url.startsWith('blob:')) return true;
        // 本地页面中的 file 图片直接加载: Firefox 的扩展页面和后台脚本都无法
        // fetch file: 地址(会报 NetworkError)，但内容脚本可以把图片绘制到 canvas。
        if (url.startsWith('file:')) return isFileOrigin(origin);
        const resolved = new URL(url, origin);
        return resolved.origin === origin;
    } catch (error) {
        return false;
    }
}

// file 页面在 Chrome 中的 origin 为 file://，Firefox 中为 null。
function isFileOrigin(origin: string): boolean {
    return origin === 'null' || origin === 'file://';
}

// 从图片 URL 加载像素数据。
// 同源图片直接读取；跨域图片必须先通过调用方提供的代理转换为 Data URL。
// 同源地址也可能被服务端 302 到 CDN (如 GitHub 的 /raw/ 跳到 raw.githubusercontent.com)，
// 此时像素对页面文档而言是跨域的，canvas 会被污染，有代理时自动改走代理重取。
export async function loadImageDataFromUrl(imageUrl: string, options: LoadImageOptions = {}): Promise<ImageData> {
    const origin = options.origin ?? window.location.origin;
    const sameOrigin = isSameOrigin(imageUrl, origin);

    if (sameOrigin) {
        try {
            const img = await loadImageElement(imageUrl);
            return await getImageDataFromImageElement(img);
        } catch (error) {
            // 只有"像素读不出来"才值得用代理重试一次; 图片本身加载失败时重试没有意义
            if (!options.fetchViaProxy || !isTaintedCanvasError(error)) throw error;
            try {
                const dataUrl = await options.fetchViaProxy(imageUrl);
                return await getImageDataFromDataUrl(dataUrl);
            } catch {
                // 代理也拿不到图: 保留原始的污染错误, 通知里据此引导改用扫描屏幕
                throw error;
            }
        }
    }

    if (!options.fetchViaProxy) {
        throw new Error('Cross-origin image requires a proxy fetcher.');
    }

    const dataUrl = await options.fetchViaProxy(imageUrl);
    return getImageDataFromDataUrl(dataUrl);
}

// canvas 被跨域数据污染: Chrome 报 "tainted by cross-origin data",
// Firefox 报 "The operation is insecure."，两者都说明像素无法读取。
function isTaintedCanvasError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /tainted|insecure|SecurityError/i.test(message);
}

// 扫描结果及来源类型，来源用于在通知中区分二维码和条形码。
// bounds 是码在原图中的包围盒（像素），供调用方在画面上标出位置。
export type DecodeResult = {
    text: string;
    kind: 'qr' | 'barcode';
    bounds?: { x: number; y: number; width: number; height: number };
};

// 灰度图：每像素 1 字节。ZXing 只需要亮度，用灰度数据比 RGBA 少 3/4 内存，
// 大图反复生成阈值候选图时不容易触发垃圾回收抖动。
type GrayImage = {
    data: Uint8ClampedArray;
    width: number;
    height: number;
};

// 按人眼亮度取灰度：绿色权重最高。
function toGrayImage(imageData: ImageData): GrayImage {
    const { width, height, data } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    for (let index = 0; index < gray.length; index++) {
        const offset = index * 4;
        gray[index] = ((data[offset] ?? 0) + (data[offset + 1] ?? 0) * 2 + (data[offset + 2] ?? 0)) >> 2;
    }
    return { data: gray, width, height };
}

// ZXing 扫描参数：TRY_HARDER 会尝试更多定位图案组合，用于倾斜、模糊的实拍图片。
const zxingHints = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]]);

// 一维条形码的候选格式。
// 不使用 MultiFormatOneDReader：它会连带打包尚未完善的 RSS 系列读取器，
// 体积多出约 120KB。Codabar 没有校验位、误扫描率高，ZXing 默认也将其禁用。
const oneDHints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.TRY_HARDER, true],
    [
        DecodeHintType.POSSIBLE_FORMATS,
        [
            BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39,
            BarcodeFormat.CODE_93,
            BarcodeFormat.EAN_13,
            BarcodeFormat.EAN_8,
            BarcodeFormat.UPC_A,
            BarcodeFormat.UPC_E,
            BarcodeFormat.ITF,
        ],
    ],
]);

// 依次尝试上面列出的几种一维格式，任一命中即返回。
class SupportedOneDReader extends OneDReader {
    private readonly readers: OneDReader[] = [
        new MultiFormatUPCEANReader(oneDHints),
        new Code39Reader(),
        new Code93Reader(),
        new Code128Reader(),
        new ITFReader(),
    ];

    decodeRow(rowNumber: number, row: BitArray, hints?: Map<DecodeHintType, unknown>): Result {
        for (const reader of this.readers) {
            try {
                return reader.decodeRow(rowNumber, row, hints);
            } catch {
                // 当前行不是这种格式，继续尝试下一个格式。
            }
        }
        throw new NotFoundException();
    }
}

const qrReader = new QRCodeReader();
const oneDReader = new SupportedOneDReader();

// 一维条形码逐行扫描的尺寸上限。条形码的模块宽度通常远大于 1 像素，
// 缩小后仍可扫描，但大图的逐行扫描会明显拖慢失败场景下的兜底速度。
const BARCODE_SCAN_DIMENSION = 1600;

// 行扫描只处理水平方向，因此一维扫描只需要灰度图和一种二值化方式。
function decodeOneDResultWithZXing(gray: GrayImage): Result | null {
    try {
        return oneDReader.decode(createZXingBitmap(gray), oneDHints);
    } catch {
        return null;
    }
}

// 修复文字被识别成条形码的问题: 一维行扫描命中一行就返回，而 PDF 正文、网页段落里
// 一行的笔画与字距偶尔能凑出校验位也合法的条码图案，于是弹出了莫名其妙的条码结果。
// 真实条形码在条高范围内每一行都是同一组条空，越界的窄条码至少也会覆盖上下相邻行，
// 因此命中后再核对命中行上下各两行，只有同一结果重复出现才认作条形码。
const BARCODE_CONFIRM_ROW_OFFSETS = [-1, 1, -2, 2];
const BARCODE_CONFIRM_MIN_HITS = 2;

// 读取指定行并尝试解码，返回识别出的文本；原本左右翻转的条码要反转整行再读一次。
function decodeRowText(bitmap: BinaryBitmap, width: number, rowNumber: number): string {
    let row: BitArray | null = null;
    try {
        row = bitmap.getBlackRow(rowNumber, new BitArray(width));
    } catch {
        // 全黑或全白行取不到黑点阈值
        return '';
    }
    if (!row) return '';

    try {
        return oneDReader.decodeRow(rowNumber, row, oneDHints).getText();
    } catch {
        // 正向读不出，再试左右翻转
    }

    const reversed = row.clone();
    reversed.reverse();
    try {
        return oneDReader.decodeRow(rowNumber, reversed, oneDHints).getText();
    } catch {
        return '';
    }
}

// 核对命中行附近的若干行: 同一文本出现次数够多才认为确实存在条形码。
// 一维结果的定位点落在扫描行两端，竖直条码经过 ZXing 的旋转扫描后两个点的 x 相同。
function isOneDResultConfirmed(result: Result, gray: GrayImage): boolean {
    const [start, end] = result.getResultPoints() ?? [];
    if (!start || !end) return false;

    const horizontal = Math.abs(start.getY() - end.getY()) <= Math.abs(start.getX() - end.getX());
    // 竖直条码: 顺时针转 90° 后原图的列变成旋转图的行，行号 = 宽度 - 1 - x
    const scanGray = horizontal ? gray : rotateGray90(gray);
    const line = horizontal ? Math.round(start.getY()) : scanGray.height - 1 - Math.round(start.getX());
    const text = result.getText();
    const bitmap = createZXingBitmap(scanGray);

    let hits = 0;
    for (const offset of BARCODE_CONFIRM_ROW_OFFSETS) {
        const rowNumber = line + offset;
        if (rowNumber < 0 || rowNumber >= scanGray.height) continue;
        if (decodeRowText(bitmap, scanGray.width, rowNumber) !== text) continue;
        if (++hits >= BARCODE_CONFIRM_MIN_HITS) return true;
    }

    return false;
}

// 按整数倍缩小灰度图，对每个块取平均，避免条形码的细线在缩放中丢失。
function downscaleGrayToMaxDimension(gray: GrayImage, maxDimension: number): GrayImage {
    const { width, height, data } = gray;
    const factor = Math.ceil(Math.max(width, height) / maxDimension);
    if (factor <= 1) return gray;

    const targetWidth = Math.floor(width / factor);
    const targetHeight = Math.floor(height / factor);
    const output = new Uint8ClampedArray(targetWidth * targetHeight);
    const blockSize = factor * factor;

    for (let y = 0; y < targetHeight; y++) {
        for (let x = 0; x < targetWidth; x++) {
            let sum = 0;
            for (let offsetY = 0; offsetY < factor; offsetY++) {
                const rowStart = (y * factor + offsetY) * width + x * factor;
                for (let offsetX = 0; offsetX < factor; offsetX++) {
                    sum += data[rowStart + offsetX] ?? 0;
                }
            }
            output[y * targetWidth + x] = sum / blockSize;
        }
    }

    return { data: output, width: targetWidth, height: targetHeight };
}

// 顺时针旋转 90 度，交换宽高。
function rotateGray90(gray: GrayImage): GrayImage {
    const { width, height, data } = gray;
    const output = new Uint8ClampedArray(data.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            output[x * height + (height - 1 - y)] = data[y * width + x] ?? 0;
        }
    }

    return { data: output, width: height, height: width };
}

// 用 ZXing 扫描单一灰度候选图，结果中带有定位点，批量扫描据此遮罩已找到的区域。
function decodeQrResultWithZXing(gray: GrayImage): Result | null {
    try {
        return qrReader.decode(createZXingBitmap(gray), zxingHints);
    } catch {
        return null;
    }
}

// 灰度图直接作为 Y 平面交给 ZXing，不需要再复制成亮度数组。
function createZXingBitmap(gray: GrayImage): BinaryBitmap {
    const { data, width, height } = gray;
    const source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
    return new BinaryBitmap(new GlobalHistogramBinarizer(source));
}

// 生成灰度阈值图，深色像素变黑，其他变白。
function thresholdGray(gray: GrayImage, threshold: number): GrayImage {
    const data = new Uint8ClampedArray(gray.data.length);
    for (let index = 0; index < data.length; index++) {
        data[index] = (gray.data[index] ?? 0) < threshold ? 0 : 255;
    }
    return { data, width: gray.width, height: gray.height };
}

// 生成反色灰度图，用于扫描白码黑底的二维码。
function invertGray(gray: GrayImage): GrayImage {
    const data = new Uint8ClampedArray(gray.data.length);
    for (let index = 0; index < data.length; index++) {
        data[index] = 255 - (gray.data[index] ?? 0);
    }
    return { data, width: gray.width, height: gray.height };
}

// 对黑色像素进行方形邻域膨胀。
// 圆点型二维码的模块之间有间隙，轻微膨胀可帮助 ZXing 连接模块并扫描定位点。
function dilateBlackPixels(gray: GrayImage, radius: number): GrayImage {
    const { width, height, data } = gray;
    const output = new Uint8ClampedArray(data);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[y * width + x] !== 0) continue;

            for (let offsetY = -radius; offsetY <= radius; offsetY++) {
                const targetY = y + offsetY;
                if (targetY < 0 || targetY >= height) continue;

                for (let offsetX = -radius; offsetX <= radius; offsetX++) {
                    const targetX = x + offsetX;
                    if (targetX < 0 || targetX >= width) continue;
                    output[targetY * width + targetX] = 0;
                }
            }
        }
    }

    return { data: output, width, height };
}

// 码面本身是一个清晰的矩形: 无论背景是深色、浅色, 还是与码面黑模块完全同色,
// 矩形内部的纹理都与外部平坦区域形成直线分界。先按块方差找出这些纹理连通域,
// 再用纹理像素计数把四条边收准, 裁出来补上白边, 相当于给二维码补静区。
// 这样也顺带解决了截图里二维码只占一小块、四周还有大量文字干扰的情况。
const CODE_AREA_BLOCK = 4;
// 块内标准差达到该值才认为块内含纹理; 纯色背景加平坦图片区域都远低于此值。
const CODE_AREA_MIN_STD = 20;
// 相邻像素亮度差达到该值即视为纹理像素, 用于把块级包围盒收敛到像素级边界。
const TEXTURE_EDGE_DELTA = 60;
// 只处理最大的几个连通域, 避免页面里大量文字块让候选图数量失控。
const CODE_AREA_MAX_COMPONENTS = 3;
// 裁剪后补白边的比例(相对码面边长), 约等于二维码 4 个模块的静区。
const CODE_AREA_PADDING_RATIO = 1 / 12;
// 边界收敛会有一两个像素的误差, 用少量内缩量各试一次, 比追求一次收准更稳。
const CODE_AREA_INSETS = [0, 1, -1];

type Box = { x0: number; y0: number; x1: number; y1: number };

// 用块方差找出"有内容"的区域, 返回按纹理面积排序的包围盒(已换算成像素坐标)。
function findTexturedBoxes(gray: GrayImage): Box[] {
    const { width, height, data } = gray;
    const blockWidth = Math.ceil(width / CODE_AREA_BLOCK);
    const blockHeight = Math.ceil(height / CODE_AREA_BLOCK);
    const sums = new Float64Array(blockWidth * blockHeight);
    const squares = new Float64Array(blockWidth * blockHeight);
    const counts = new Float64Array(blockWidth * blockHeight);

    for (let y = 0; y < height; y++) {
        const rowBlock = Math.floor(y / CODE_AREA_BLOCK) * blockWidth;
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            const block = rowBlock + Math.floor(x / CODE_AREA_BLOCK);
            const value = data[rowOffset + x]!;
            sums[block] = sums[block]! + value;
            squares[block] = squares[block]! + value * value;
            counts[block] = counts[block]! + 1;
        }
    }

    const active = new Uint8Array(sums.length);
    for (let index = 0; index < active.length; index++) {
        const count = counts[index]!;
        if (!count) continue;
        const mean = sums[index]! / count;
        const std = Math.sqrt(Math.max(0, squares[index]! / count - mean * mean));
        active[index] = std >= CODE_AREA_MIN_STD ? 1 : 0;
    }

    const visited = new Uint8Array(active.length);
    const boxes: { box: Box; weight: number }[] = [];
    const stack: number[] = [];

    for (let start = 0; start < active.length; start++) {
        if (!active[start] || visited[start]) continue;
        stack.push(start);
        visited[start] = 1;

        let minX = blockWidth;
        let minY = blockHeight;
        let maxX = -1;
        let maxY = -1;
        let weight = 0;

        while (stack.length) {
            const index = stack.pop()!;
            const x = index % blockWidth;
            const y = Math.floor(index / blockWidth);
            weight++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            for (let offsetY = -1; offsetY <= 1; offsetY++) {
                for (let offsetX = -1; offsetX <= 1; offsetX++) {
                    const nextX = x + offsetX;
                    const nextY = y + offsetY;
                    if (nextX < 0 || nextY < 0 || nextX >= blockWidth || nextY >= blockHeight) continue;
                    const next = nextY * blockWidth + nextX;
                    if (!active[next] || visited[next]) continue;
                    visited[next] = 1;
                    stack.push(next);
                }
            }
        }

        boxes.push({
            box: {
                x0: minX * CODE_AREA_BLOCK,
                y0: minY * CODE_AREA_BLOCK,
                x1: Math.min(width, (maxX + 1) * CODE_AREA_BLOCK),
                y1: Math.min(height, (maxY + 1) * CODE_AREA_BLOCK),
            },
            weight,
        });
    }

    boxes.sort((a, b) => b.weight - a.weight);
    return boxes.slice(0, CODE_AREA_MAX_COMPONENTS).map((entry) => entry.box);
}

// 块级包围盒边缘会有一两个块的余量, 用行列上的纹理像素数把四条边收敛到真实边界。
function refineBoxToPixels(gray: GrayImage, coarse: Box): Box | null {
    const { width, height, data } = gray;
    const texture = new Uint8Array((coarse.x1 - coarse.x0) * (coarse.y1 - coarse.y0));
    const localWidth = coarse.x1 - coarse.x0;
    let textured = 0;

    for (let y = coarse.y0; y < coarse.y1; y++) {
        for (let x = coarse.x0; x < coarse.x1; x++) {
            const value = data[y * width + x]!;
            const left = data[y * width + Math.max(0, x - 1)]!;
            const right = data[y * width + Math.min(width - 1, x + 1)]!;
            const top = data[Math.max(0, y - 1) * width + x]!;
            const bottom = data[Math.min(height - 1, y + 1) * width + x]!;
            const max = Math.max(value, left, right, top, bottom);
            const min = Math.min(value, left, right, top, bottom);
            if (max - min < TEXTURE_EDGE_DELTA) continue;
            texture[(y - coarse.y0) * localWidth + (x - coarse.x0)] = 1;
            textured++;
        }
    }

    // 几乎是纯色块时没必要继续, 裁出来也扫描不到。
    if (textured < localWidth * 4) return null;

    const rows = coarse.y1 - coarse.y0;
    const columns = coarse.x1 - coarse.x0;
    const rowMinimum = Math.max(2, Math.round(columns * 0.05));
    const columnMinimum = Math.max(2, Math.round(rows * 0.05));
    const countRow = (row: number) => {
        let total = 0;
        for (let x = 0; x < columns; x++) total += texture[row * localWidth + x]!;
        return total;
    };
    const countColumn = (column: number) => {
        let total = 0;
        for (let y = 0; y < rows; y++) total += texture[y * localWidth + column]!;
        return total;
    };

    let top = -1;
    let bottom = -1;
    let left = -1;
    let right = -1;
    for (let row = 0; row < rows; row++) {
        if (countRow(row) >= rowMinimum) {
            top = row;
            break;
        }
    }
    for (let row = rows - 1; row >= 0; row--) {
        if (countRow(row) >= rowMinimum) {
            bottom = row;
            break;
        }
    }
    for (let column = 0; column < columns; column++) {
        if (countColumn(column) >= columnMinimum) {
            left = column;
            break;
        }
    }
    for (let column = columns - 1; column >= 0; column--) {
        if (countColumn(column) >= columnMinimum) {
            right = column;
            break;
        }
    }

    if (top < 0 || bottom <= top || left < 0 || right <= left) return null;
    return {
        x0: coarse.x0 + left,
        y0: coarse.y0 + top,
        x1: coarse.x0 + right + 1,
        y1: coarse.y0 + bottom + 1,
    };
}

// 把矩形区域裁出来并补上指定数值的边框(白色相当于静区)。
// 记下裁剪图左上角在原图中的位置, 便于把命中位置换算回原图。
function cropWithPadding(gray: GrayImage, box: Box, padding: number, inset: number): Candidate | null {
    const { width, height, data } = gray;
    const x0 = Math.max(0, box.x0 + inset);
    const y0 = Math.max(0, box.y0 + inset);
    const x1 = Math.min(width, box.x1 - inset);
    const y1 = Math.min(height, box.y1 - inset);
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;
    if (cropWidth < 8 || cropHeight < 8) return null;

    const output = new Uint8ClampedArray((cropWidth + padding * 2) * (cropHeight + padding * 2)).fill(255);
    const outputWidth = cropWidth + padding * 2;
    for (let y = 0; y < cropHeight; y++) {
        output.set(data.subarray((y0 + y) * width + x0, (y0 + y) * width + x1), (y + padding) * outputWidth + padding);
    }

    return {
        image: { data: output, width: outputWidth, height: cropHeight + padding * 2 },
        offsetX: x0 - padding,
        offsetY: y0 - padding,
    };
}

// 生成"按码面矩形裁剪并补白边"的候选图, 用于背景与模块同色、四周有大量干扰的截图。
function createCodeAreaCandidates(gray: GrayImage): Candidate[] {
    if (gray.width < 32 || gray.height < 32) return [];

    const candidates: Candidate[] = [];
    for (const coarse of findTexturedBoxes(gray)) {
        const box = refineBoxToPixels(gray, coarse);
        if (!box) continue;

        const padding = Math.max(8, Math.round(Math.max(box.x1 - box.x0, box.y1 - box.y0) * CODE_AREA_PADDING_RATIO));
        for (const inset of CODE_AREA_INSETS) {
            const candidate = cropWithPadding(gray, box, padding, inset);
            if (candidate) candidates.push(candidate);
        }
    }

    return candidates;
}

// ---------------------------- 批量扫描 ----------------------------

// 批量扫描的规模上限: 结果数、定位点数量与三角组合的尝试次数。
// 批量模式由用户显式触发, 但仍需限流, 避免密集二维码图片让耗时失控。
const MULTI_MAX_RESULTS = 20;
const MULTI_MAX_BARCODE_PASS = 8;
// 彩色标签的灰度值分布差异很大: 白底标签的条码靠原图即可扫描,
// 红/绿色底的低对比度条码往往需要较低的固定阈值才能分离出黑条。
const BARCODE_THRESHOLDS = [48, 64];
const MULTI_MAX_FINDER_CENTERS = 30;
const MULTI_MAX_DECODE_ATTEMPTS = 1200;
// 4 种整图候选 + 最多 3 个码面矩形 × 3 个内缩量 + 缩小整图的 4 种候选; 裁剪图很小, 多试几次仍然很快。
const MULTI_MAX_CANDIDATES = 17;

// 修复整页截图扫不出码的问题: ZXing 的定位点查找对单个模块的像素尺寸很敏感,
// 高 DPR 截屏里二维码模块动辄二三十像素, 定位点反而漏检(同一张图缩小一档就能扫出)。
// 整图和码面矩形都失败时, 把整图缩到这个长边再试一次。
const QR_DOWNSCALE_DIMENSION = 1200;

// 让出主线程, 使批量扫描的长计算不会冻结 popup 或页面。
const yieldToMainThread = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type LocatedResult = DecodeResult & { x: number; y: number };

// 候选灰度图及其左上角在原图中的位置: 裁剪出的候选图需要用它把命中位置平移回原图,
// 缩放过的候选图还要乘上缩放比例。
type Candidate = { image: GrayImage; offsetX: number; offsetY: number; scale?: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 把包围盒换算成可直接用于绘制的矩形, 并限制在原图范围内。
const toRect = (bounds: Bounds, width: number, height: number) => {
    const minX = clamp(Math.floor(bounds.minX), 0, Math.max(0, width - 1));
    const minY = clamp(Math.floor(bounds.minY), 0, Math.max(0, height - 1));
    const maxX = clamp(Math.ceil(bounds.maxX), 0, Math.max(0, width - 1));
    const maxY = clamp(Math.ceil(bounds.maxY), 0, Math.max(0, height - 1));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
};

// ZXing 给出的包围盒只到定位点中心, 二维码外圈还有数据模块;
// 按模块尺寸向外扩一圈, 让标记框住整个码面。
const padBounds = (bounds: Bounds | null, pad: number, width: number, height: number): Bounds | null =>
    bounds && {
        minX: clamp(bounds.minX - pad, 0, Math.max(0, width - 1)),
        minY: clamp(bounds.minY - pad, 0, Math.max(0, height - 1)),
        maxX: clamp(bounds.maxX + pad, 0, Math.max(0, width - 1)),
        maxY: clamp(bounds.maxY + pad, 0, Math.max(0, height - 1)),
    };

// 一维码的定位点只落在扫描行上, 竖直范围未知; 实测失败时按条码常见的高宽比估算高度。
const expandBarcodeBounds = (bounds: Bounds, rows: boolean, limit: number): Bounds => {
    const span = rows ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY;
    const pad = Math.max(4, span * 0.08);
    const last = Math.max(0, limit - 1);
    return rows
        ? {
              minX: bounds.minX,
              maxX: bounds.maxX,
              minY: clamp(bounds.minY - pad, 0, last),
              maxY: clamp(bounds.maxY + pad, 0, last),
          }
        : {
              minX: clamp(bounds.minX - pad, 0, last),
              maxX: clamp(bounds.maxX + pad, 0, last),
              minY: bounds.minY,
              maxY: bounds.maxY,
          };
};

// 修复条形码标记框塌成一条横带的问题:
// 一维结果的定位点只有扫描行两端, 条高方向的范围只能靠宽度比例估算, 条码一高就框不住
// 条面 (UPC 条码高约等于宽的一半, 估算只补了宽度的 8%)。改为在原图上实测条高:
// 定位点跨度总落在扫描行方向, 因此包围盒的短边方向就是条高方向, 沿短边找与命中行
// 同一组条空的连续带, 再逐行解码确认边界。
const BARCODE_PROFILE_MIN_IOU = 0.7;
const BARCODE_PROFILE_MIN_INK = 0.05;
// 允许连续几行条空对不上, 避免条面上一道水印、反光提前截断高度。
const BARCODE_PROFILE_MISS_ALLOWANCE = 1;
const BARCODE_EDGE_REFINE_PROBES = 24;

const isBarcodeRowAxis = (bounds: Bounds) => bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;

type CodeProfile = { bits: Uint8Array; ink: number };

// 沿条空排列方向取剖面: rows 为 true 时读第 index 行, 否则读第 index 列。
// 阈值取该剖面内的对比度中值, 整图阈值在浅色条码或暗背景上会失效。
function readCodeProfile(gray: GrayImage, index: number, from: number, to: number, rows: boolean): CodeProfile | null {
    const length = to - from + 1;
    if (length <= 0) return null;

    const { data, width } = gray;
    let min = 255;
    let max = 0;
    for (let offset = 0; offset < length; offset++) {
        const value = rows ? data[index * width + from + offset] ?? 0 : data[(from + offset) * width + index] ?? 0;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (max - min < 24) return null;

    const threshold = (min + max) / 2;
    const bits = new Uint8Array(length);
    let ink = 0;
    for (let offset = 0; offset < length; offset++) {
        const value = rows ? data[index * width + from + offset] ?? 0 : data[(from + offset) * width + index] ?? 0;
        if (value < threshold) {
            bits[offset] = 1;
            ink++;
        }
    }
    return { bits, ink: ink / length };
}

// 条面内每一行的条空位置几乎相同, 用交并比判断是否属于同一个条码;
// 白边、下方的数字行与条空对不上, 交并比会明显下降。
function isSameCodeProfile(profile: CodeProfile, base: CodeProfile): boolean {
    if (profile.ink < BARCODE_PROFILE_MIN_INK) return false;
    let intersection = 0;
    let union = 0;
    for (let index = 0; index < base.bits.length; index++) {
        const a = base.bits[index];
        const b = profile.bits[index];
        if (a || b) union++;
        if (a && b) intersection++;
    }
    return union > 0 && intersection / union >= BARCODE_PROFILE_MIN_IOU;
}

// 从命中位置向两侧走, 连续若干行条空对不上即认为离开条面。
function profileCodeBand(
    gray: GrayImage,
    base: CodeProfile,
    from: number,
    to: number,
    center: number,
    rows: boolean,
): { min: number; max: number } {
    const limit = rows ? gray.height : gray.width;
    const walk = (step: -1 | 1): number => {
        let edge = center;
        let misses = 0;
        for (let index = center + step; index >= 0 && index < limit; index += step) {
            const profile = readCodeProfile(gray, index, from, to, rows);
            if (profile && isSameCodeProfile(profile, base)) {
                edge = index;
                misses = 0;
                continue;
            }
            if (++misses > BARCODE_PROFILE_MISS_ALLOWANCE) break;
        }
        return edge;
    };

    return { min: walk(-1), max: walk(1) };
}

// 剖面边界附近再逐行解码: 仍能解出同一文本就继续向外, 解不出说明已到条面边缘,
// 让框贴着真正可读的条面而不是整块标签。
function refineBarcodeEdge(
    bitmap: BinaryBitmap,
    width: number,
    height: number,
    text: string,
    from: number,
    step: -1 | 1,
): number {
    let edge = from;
    for (let probe = 0; probe < BARCODE_EDGE_REFINE_PROBES; probe++) {
        const y = edge + step;
        if (y < 0 || y >= height) break;
        if (decodeRowText(bitmap, width, y) !== text) break;
        edge = y;
    }
    return edge;
}

// 在原图上实测条高方向的范围; 剖面或解码都失败时退回比例估算。
function measureBarcodeBounds(gray: GrayImage, bounds: Bounds, text: string): Bounds {
    const rows = isBarcodeRowAxis(bounds);
    const limit = rows ? gray.height : gray.width;
    const last = Math.max(0, limit - 1);
    const from = rows
        ? clamp(Math.floor(bounds.minX), 0, gray.width - 1)
        : clamp(Math.floor(bounds.minY), 0, gray.height - 1);
    const to = rows
        ? clamp(Math.ceil(bounds.maxX), 0, gray.width - 1)
        : clamp(Math.ceil(bounds.maxY), 0, gray.height - 1);
    const center = rows
        ? clamp(Math.round((bounds.minY + bounds.maxY) / 2), 0, last)
        : clamp(Math.round((bounds.minX + bounds.maxX) / 2), 0, last);

    const base = to > from ? readCodeProfile(gray, center, from, to, rows) : null;
    const band = base && profileCodeBand(gray, base, from, to, center, rows);
    if (!band) return expandBarcodeBounds(bounds, rows, limit);

    if (!rows) {
        // 竖直条码的条高沿列分布, ZXing 的行解码确认不适用, 边界误差在 1~2 像素内。
        return { minX: band.min, maxX: band.max, minY: bounds.minY, maxY: bounds.maxY };
    }

    const bitmap = createZXingBitmap(gray);
    return {
        minX: bounds.minX,
        maxX: bounds.maxX,
        minY: refineBarcodeEdge(bitmap, gray.width, gray.height, text, band.min, -1),
        maxY: refineBarcodeEdge(bitmap, gray.width, gray.height, text, band.max, 1),
    };
}

// 候选图里的坐标换算回原图: 裁剪候选图靠偏移平移, 缩放候选图还要先乘回缩放比例,
// 越界部分由 toRect 统一夹紧。
const shiftBounds = (bounds: Bounds | null, candidate: Candidate): Bounds | null => {
    if (!bounds) return null;
    const scale = candidate.scale ?? 1;
    return {
        minX: bounds.minX * scale + candidate.offsetX,
        minY: bounds.minY * scale + candidate.offsetY,
        maxX: bounds.maxX * scale + candidate.offsetX,
        maxY: bounds.maxY * scale + candidate.offsetY,
    };
};

// 扫描一张图片中的所有二维码和条形码。
// 二维码一次扫描整张图收集全部定位点, 再对定位点三角组合逐个解码,
// 因此并排、堆叠或混排的多个码都能找到; 条形码则通过遮罩逐轮找出。
export async function decodeAllFromImageData(imageData: ImageData): Promise<DecodeResult[]> {
    const gray = toGrayImage(imageData);
    const found: LocatedResult[] = [];
    const seen = new Set<string>();

    // bounds 已在原图坐标系中, 用于排序和在页面上标出码的位置
    const add = (text: string, kind: DecodeResult['kind'], bounds: Bounds | null) => {
        if (!text || found.length >= MULTI_MAX_RESULTS) return;
        const key = `${kind}:${text}`;
        if (seen.has(key)) return;
        seen.add(key);
        const rect = bounds ? toRect(bounds, gray.width, gray.height) : null;
        found.push({
            text,
            kind,
            bounds: rect ?? undefined,
            x: rect ? rect.x + rect.width / 2 : 0,
            y: rect ? rect.y + rect.height / 2 : 0,
        });
    };

    // 一维条形码先扫: 与单码流程保持一致, 命中时更省时间。
    for (const hit of decodeAllBarcodesWithZXing(gray)) {
        add(hit.text, 'barcode', hit.bounds);
    }
    await yieldToMainThread();

    let candidateIndex = 0;
    for (const candidate of createMultiQrCandidates(gray)) {
        if (found.length >= MULTI_MAX_RESULTS || candidateIndex >= MULTI_MAX_CANDIDATES) break;

        const codes = decodeMultipleQrWithZXing(candidate.image);
        if (codes.length) {
            for (const code of codes) {
                add(code.text, 'qr', shiftBounds(code.bounds, candidate));
            }
        } else {
            // 定位点检测失败时退回单码扫描, 兼容彩色、圆点等特殊码面。
            const fallback = decodeQrResultWithZXing(candidate.image);
            const text = fallback?.getText() ?? '';
            if (fallback && text) {
                const bounds = getResultBounds(fallback, candidate.image.width, candidate.image.height);
                add(text, 'qr', shiftBounds(bounds, candidate));
            }
        }

        candidateIndex++;
        await yieldToMainThread();
    }

    // 按从上到下、从左到右的顺序展示。
    found.sort((a, b) => a.y - b.y || a.x - b.x);
    return found.map(({ text, kind, bounds }) => ({ text, kind, bounds }));
}

// ---------------------------- 摄像头取帧 ----------------------------

// 连续扫描时轮换的候选图数量: 原图、阈值图、反色图各占一帧。
const CAMERA_CANDIDATE_COUNT = 3;

// 扫描一帧视频画面: 命中即返回, 未命中返回空数组, 由调用方在下一帧重试。
// 与 decodeAllFromImageData 不同, 这里单帧只做一次二维码 + 一次条形码,
// 阈值/反色候选分摊到后续帧, 避免实时预览被计算拖慢;
// 多码结果由调用方在命中后对同一帧补跑一次完整扫描。
export function decodeCameraFrame(imageData: ImageData, attempt = 0): DecodeResult[] {
    const gray = toGrayImage(imageData);
    const index = ((attempt % CAMERA_CANDIDATE_COUNT) + CAMERA_CANDIDATE_COUNT) % CAMERA_CANDIDATE_COUNT;
    const candidate = index === 0 ? gray : index === 1 ? thresholdGray(gray, 160) : invertGray(gray);

    const qrText = decodeQrResultWithZXing(candidate)?.getText() ?? '';
    if (qrText) return [{ text: qrText, kind: 'qr' }];

    // 条形码靠行扫描, 阈值/反色会破坏条空比例, 只在原图上尝试。
    const barcodeScaled = downscaleGrayToMaxDimension(gray, BARCODE_SCAN_DIMENSION);
    const barcodeResult = decodeOneDResultWithZXing(barcodeScaled);
    return barcodeResult && isOneDResultConfirmed(barcodeResult, barcodeScaled)
        ? [{ text: barcodeResult.getText(), kind: 'barcode' }]
        : [];
}

// 批量模式的整图候选, 按命中概率排序; 候选过多时优先处理最常见的几种。
function* createMultiQrCandidates(gray: GrayImage): Generator<Candidate> {
    yield* createWholeImageCandidates(gray, 1);

    // 背景与码面同色、或截图里码面只占一小块时, 整图永远找不到静区,
    // 最后按码面矩形裁剪并补白边兜底。
    yield* createCodeAreaCandidates(gray);

    // 整页截图里的码在原始尺寸下可能因为模块过大而漏掉定位点, 整图缩一档再扫一遍;
    // 命中的坐标由候选图的缩放比例换回原图。
    const smaller = downscaleGrayToMaxDimension(gray, QR_DOWNSCALE_DIMENSION);
    if (smaller !== gray) {
        yield* createWholeImageCandidates(smaller, gray.width / smaller.width);
    }
}

// 整图候选: 原图, 以及能覆盖低对比度、反色、圆点码的几种变体。
function* createWholeImageCandidates(gray: GrayImage, scale: number): Generator<Candidate> {
    yield { image: gray, offsetX: 0, offsetY: 0, scale };
    yield { image: thresholdGray(gray, 160), offsetX: 0, offsetY: 0, scale };
    yield { image: invertGray(gray), offsetX: 0, offsetY: 0, scale };
    yield { image: dilateBlackPixels(thresholdGray(gray, 160), 1), offsetX: 0, offsetY: 0, scale };
}

// ZXing 的 QRCodeReader 只支持单码: 图片中出现多个码时, 它可能把不同码的定位点
// 组合在一起, 导致整图扫描失败。这里改为一次收集所有定位点, 再枚举 plausible 的
// 三角组合逐个解码, 相当于补上官方 MultiDetector 的能力。
function decodeMultipleQrWithZXing(gray: GrayImage): { text: string; bounds: Bounds | null }[] {
    const bitmap = createHybridBitmap(gray);
    const matrix = bitmap.getBlackMatrix();
    const finder = new FinderPatternFinder(matrix, noopResultPointCallback) as unknown as MultiFinderPatternFinder;

    // 单码查找器凑够三个定位点就会停止; 批量扫描要扫描完整张图。
    finder.haveMultiplyConfirmedCenters = () => false;
    finder.findRowSkip = () => 0;
    finder.selectBestPatterns = function selectFirstPatterns(this: MultiFinderPatternFinder) {
        return this.getPossibleCenters().slice(0, 3);
    };

    try {
        finder.find(zxingHints);
    } catch {
        // 定位点不足三个时会抛出异常, 已收集到的定位点仍然可用。
    }

    const centers = finder
        .getPossibleCenters()
        .filter((center) => center.getEstimatedModuleSize() >= 1)
        .sort((a, b) => b.getCount() - a.getCount())
        .slice(0, MULTI_MAX_FINDER_CENTERS);

    if (centers.length < 3) return [];

    const detector = new Detector(matrix) as unknown as MultiDetector;
    const decoder = new Decoder();
    const results: { text: string; bounds: Bounds | null }[] = [];
    const seen = new Set<string>();
    let attempts = 0;

    for (let i = 0; i < centers.length - 2; i++) {
        for (let j = i + 1; j < centers.length - 1; j++) {
            for (let k = j + 1; k < centers.length; k++) {
                if (results.length >= MULTI_MAX_RESULTS) return results;

                const points = [centers[i]!, centers[j]!, centers[k]!];
                // 同一个二维码的三个定位点模块尺寸相近, 先排除明显不匹配的组合。
                const sizes = points.map((point) => point.getEstimatedModuleSize());
                if (Math.max(...sizes) > Math.min(...sizes) * 2.5) continue;

                ResultPoint.orderBestPatterns(points);
                if (!isPlausibleQrTriangle(points)) continue;

                // 只统计真正进入检测/解码的尝试次数, 组合枚举本身很廉价。
                if (attempts++ >= MULTI_MAX_DECODE_ATTEMPTS) return results;

                try {
                    const detected = detector.processFinderPatternInfo(new FinderPatternInfo(points));
                    const text = decoder.decodeBitMatrix(detected.getBits(), zxingHints).getText();
                    if (!text || seen.has(text)) continue;
                    seen.add(text);
                    const moduleSize = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
                    results.push({
                        text,
                        bounds: padBounds(
                            getPointBounds(detected.getPoints(), gray.width, gray.height),
                            moduleSize * 3.5,
                            gray.width,
                            gray.height,
                        ),
                    });
                } catch {
                    // 该组合不是有效二维码, 继续尝试其它组合。
                }
            }
        }
    }

    return results;
}

// 三个定位点应构成近似等腰直角三角形; 用边长比例和勾股定理排除大量无效组合。
function isPlausibleQrTriangle(points: ResultPoint[]): boolean {
    const bottomLeft = points[0]!;
    const topLeft = points[1]!;
    const topRight = points[2]!;
    const legA = distance(bottomLeft, topLeft);
    const legB = distance(topRight, topLeft);
    const hypotenuse = distance(bottomLeft, topRight);

    if (legA < 4 || legB < 4 || hypotenuse < 4) return false;
    const ratio = legA / legB;
    if (ratio < 0.4 || ratio > 2.5) return false;

    const error = Math.abs(legA * legA + legB * legB - hypotenuse * hypotenuse) / (hypotenuse * hypotenuse);
    return error < 0.5;
}

function distance(a: ResultPoint, b: ResultPoint): number {
    return Math.hypot(a.getX() - b.getX(), a.getY() - b.getY());
}

// 批量扫描使用 HybridBinarizer: 它按局部区域取阈值, 在二维码只占画面一小部分时
// 比全局直方图更稳定。
function createHybridBitmap(gray: GrayImage): BinaryBitmap {
    const { data, width, height } = gray;
    const source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
    return new BinaryBitmap(new HybridBinarizer(source));
}

// ZXing 的定位点查找器和检测器把关键方法声明为 private/protected,
// 这里用交叉类型会与原有声明冲突, 因此单独描述批量扫描需要用到的方法。
type MultiFinderPatternFinder = {
    find(hints: Map<DecodeHintType, unknown>): FinderPatternInfo;
    getPossibleCenters(): FinderPattern[];
    haveMultiplyConfirmedCenters(): boolean;
    findRowSkip(): number;
    selectBestPatterns(): FinderPattern[];
};

type MultiDetector = {
    processFinderPatternInfo(info: FinderPatternInfo): DetectorResult;
};

const noopResultPointCallback: ResultPointCallback = {
    foundPossibleResultPoint: () => {},
};

type BarcodeHit = { text: string; bounds: Bounds };

// 把候选图坐标映射回原图的函数: 缩放、旋转过的候选图都靠它换算位置。
type BoundsMapper = (bounds: Bounds) => Bounds;

// 逐个找出条形码: 一维结果只给出扫描行上的两个点, 因此需要随轮次增大竖直遮罩范围,
// 直到同一个条形码被彻底遮住, 才能继续找到下一个。
function decodeAllBarcodesWithZXing(gray: GrayImage): BarcodeHit[] {
    const scaled = downscaleGrayToMaxDimension(gray, BARCODE_SCAN_DIMENSION);
    // 缩小时按整数块取平均, 用实际比例换算回原图坐标
    const scaleX = scaled.width > 0 ? gray.width / scaled.width : 1;
    const scaleY = scaled.height > 0 ? gray.height / scaled.height : 1;
    const hits: BarcodeHit[] = [];
    const seen = new Set<string>();

    const scaleMapper: BoundsMapper = (bounds) => ({
        minX: bounds.minX * scaleX,
        minY: bounds.minY * scaleY,
        maxX: bounds.maxX * scaleX,
        maxY: bounds.maxY * scaleY,
    });
    // 顺时针旋转 90° 后的候选图: x' = height - 1 - y, y' = x
    const rotateMapper: BoundsMapper = (bounds) => ({
        minX: bounds.minY * scaleX,
        maxX: bounds.maxY * scaleX,
        minY: (scaled.height - 1 - bounds.maxX) * scaleY,
        maxY: (scaled.height - 1 - bounds.minX) * scaleY,
    });

    // 原图扫描后保留遮罩结果: 已找到的条形码在后续阈值图中保持空白,
    // 既能减少重复命中, 也能避免彩色背景在阈值下被误读成新的码。
    const maskedImages = [
        { gray: scaled, mapper: scaleMapper },
        { gray: rotateGray90(scaled), mapper: rotateMapper },
    ].map((base) => ({
        gray: scanBarcodesWithMasking(cloneGray(base.gray), hits, seen, base.mapper),
        mapper: base.mapper,
    }));

    // 只有原图已经找到条形码时才尝试阈值图:
    // 彩色标签上的黑色条码灰度对比度可能不足, 阈值化后能找到同图中其余低对比度的码;
    // 完全不包含条形码的图片可以跳过这些额外扫描, 保持常规扫描的速度。
    if (hits.length) {
        for (const masked of maskedImages) {
            for (const threshold of BARCODE_THRESHOLDS) {
                scanBarcodesWithMasking(thresholdGray(masked.gray, threshold), hits, seen, masked.mapper);
            }
        }
    }

    // 命中坐标只到扫描行, 条高在精修时按原图实测:
    // 候选图超过 1600 会被缩小, 在原图上做剖面和行解码不受缩放误差影响
    return hits.map((hit) => ({ text: hit.text, bounds: measureBarcodeBounds(gray, hit.bounds, hit.text) }));
}

function scanBarcodesWithMasking(
    gray: GrayImage,
    hits: BarcodeHit[],
    seen: Set<string>,
    mapper: BoundsMapper,
): GrayImage {
    for (let pass = 0; pass < MULTI_MAX_BARCODE_PASS; pass++) {
        const result = decodeOneDResultWithZXing(gray);
        if (!result) break;
        const text = result.getText();
        const bounds = getResultBounds(result, gray.width, gray.height);
        if (!text || !bounds) break;

        // 未通过相邻行核对的是文字误判: 不采纳, 但仍遮掉这段继续找,
        // 否则一处正文误判会把同图里真正的条形码一起挡掉。
        if (isOneDResultConfirmed(result, gray) && !seen.has(text)) {
            seen.add(text);
            hits.push({ text, bounds: mapper(bounds) });
        }

        const padX = Math.max(6, Math.round(gray.width * 0.01));
        const padY = Math.max(8, Math.round(gray.height * (0.05 + pass * 0.03)));
        maskGrayRect(gray, bounds, padX, padY);
    }

    return gray;
}

function cloneGray(gray: GrayImage): GrayImage {
    return { data: new Uint8ClampedArray(gray.data), width: gray.width, height: gray.height };
}

function getResultBounds(result: Result, width: number, height: number): Bounds | null {
    return getPointBounds(result.getResultPoints(), width, height);
}

// 用定位点计算包围盒; 没有可用定位点时返回 null, 避免遮罩掉整张图。
function getPointBounds(points: ResultPoint[] | null | undefined, width: number, height: number): Bounds | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const point of points ?? []) {
        if (!point) continue;
        const x = point.getX();
        const y = point.getY();
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

    return {
        minX: clamp(Math.floor(minX), 0, width - 1),
        minY: clamp(Math.floor(minY), 0, height - 1),
        maxX: clamp(Math.ceil(maxX), 0, width - 1),
        maxY: clamp(Math.ceil(maxY), 0, height - 1),
    };
}

// 将包围盒区域涂成白色, 模拟"抹掉"已扫描的码。
function maskGrayRect(gray: GrayImage, bounds: Bounds, padX: number, padY: number) {
    const { width, height, data } = gray;
    const left = clamp(Math.floor(bounds.minX - padX), 0, width - 1);
    const right = clamp(Math.ceil(bounds.maxX + padX), 0, width - 1);
    const top = clamp(Math.floor(bounds.minY - padY), 0, height - 1);
    const bottom = clamp(Math.ceil(bounds.maxY + padY), 0, height - 1);

    for (let y = top; y <= bottom; y++) {
        data.fill(255, y * width + left, y * width + right + 1);
    }
}

// 将 HTMLImageElement 绘制到 Canvas，并提取完整像素数据。
// SVG 会先缩放到合适的尺寸：过小则放大以保留二维码细节，过大则缩小以避免生成候选图时占用过多内存。
async function getImageDataFromImageElement(img: HTMLImageElement): Promise<ImageData> {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Unable to get 2d canvas context.');
    }

    const sourceWidth = img.naturalWidth || img.width;
    const sourceHeight = img.naturalHeight || img.height;
    if (!sourceWidth || !sourceHeight) {
        throw new Error('Image has no usable dimensions.');
    }

    const isSvg = isSvgSource(img.currentSrc || img.src);
    const scale = isSvg ? getSvgScale(sourceWidth, sourceHeight) : getRasterScale(sourceWidth, sourceHeight);
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 位图放大时用平滑插值补齐模块边缘；SVG 放大保持锐利，缩小时两者都启用平滑。
    ctx.imageSmoothingEnabled = !isSvg || scale < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// 计算 SVG 的绘制缩放比例，使最长边不超过 SVG_SCAN_DIMENSION。
// 尺寸较小时最多放大 8 倍以保留二维码细节，放大后同样不超过上限。
function getSvgScale(sourceWidth: number, sourceHeight: number): number {
    const maxDimension = Math.max(sourceWidth, sourceHeight);
    if (maxDimension > SVG_SCAN_DIMENSION) {
        return SVG_SCAN_DIMENSION / maxDimension;
    }
    return Math.max(1, Math.min(8, Math.floor(SVG_SCAN_DIMENSION / maxDimension)));
}

// 位图缩放比例：小图平滑放大到目标扫描尺寸，大图保持原样。
function getRasterScale(sourceWidth: number, sourceHeight: number): number {
    const maxDimension = Math.max(sourceWidth, sourceHeight);
    if (maxDimension >= RASTER_SCAN_DIMENSION) return 1;
    return Math.min(RASTER_MAX_UPSCALE, RASTER_SCAN_DIMENSION / maxDimension);
}

// 加载 Data URL 图片，并复用统一的 Canvas 像素提取流程。
export async function getImageDataFromDataUrl(dataUrl: string): Promise<ImageData> {
    const img = await loadImageElement(dataUrl);
    return getImageDataFromImageElement(img);
}

// 将图片地址加载为 HTMLImageElement。
// 成功和失败都通过 Promise 显式返回，便于上层统一处理错误。
function loadImageElement(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image load failed.'));
        img.src = src;
    });
}

// 判断图片来源是否为 SVG，用于决定是否需要放大后再提取像素。
function isSvgSource(src: string): boolean {
    if (src.startsWith('data:image/svg+xml')) return true;
    try {
        return new URL(src, window.location.href).pathname.toLowerCase().endsWith('.svg');
    } catch {
        return false;
    }
}
