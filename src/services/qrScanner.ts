import BarcodeFormat from '@zxing/library/esm/core/BarcodeFormat';
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap';
import BitArray from '@zxing/library/esm/core/common/BitArray';
import type BitMatrix from '@zxing/library/esm/core/common/BitMatrix';
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
// ZXing 难以定位；平滑放大后模块边缘更清晰，识别率明显提升。
const RASTER_SCAN_DIMENSION = 1000;

// 位图的最大放大倍数。放大过多只会增加内存和耗时，识别率不再提升。
const RASTER_MAX_UPSCALE = 4;

// 通过后台脚本获取跨域图片，并返回可供识别器使用的 Data URL。
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
export async function loadImageDataFromUrl(imageUrl: string, options: LoadImageOptions = {}): Promise<ImageData> {
    const origin = options.origin ?? window.location.origin;
    const sameOrigin = isSameOrigin(imageUrl, origin);

    if (sameOrigin) {
        const img = await loadImageElement(imageUrl);
        return getImageDataFromImageElement(img);
    }

    if (!options.fetchViaProxy) {
        throw new Error('Cross-origin image requires a proxy fetcher.');
    }

    const dataUrl = await options.fetchViaProxy(imageUrl);
    return getImageDataFromDataUrl(dataUrl);
}

// 识别结果及来源类型，来源用于在通知中区分二维码和条形码。
export type DecodeResult = {
    text: string;
    kind: 'qr' | 'barcode';
};

// 优先识别一维条形码，失败后再按二维码识别。
// 条形码只需在缩小后的灰度图上逐行扫描，命中时比二维码的多阈值候选图更快；
// 二维码的识别全部交给 ZXing：依次尝试灰度图和不同阈值的二值化图，
// 兼顾过曝、低对比度、圆点模块和白码黑底等情况。
export async function decodeQrFromImageData(imageData: ImageData): Promise<DecodeResult | null> {
    const gray = toGrayImage(imageData);

    const barcode = decodeBarcodeWithZXing(gray);
    if (barcode) return { text: barcode, kind: 'barcode' };

    for (const candidate of createQrCandidates(gray)) {
        const text = decodeQrWithZXing(candidate);
        if (text) return { text, kind: 'qr' };
    }

    return null;
}

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

// ZXing 识别参数：TRY_HARDER 会尝试更多定位图案组合，用于倾斜、模糊的实拍图片。
const zxingHints = new Map<DecodeHintType, unknown>([[DecodeHintType.TRY_HARDER, true]]);

// 一维条形码的候选格式。
// 不使用 MultiFormatOneDReader：它会连带打包尚未完善的 RSS 系列读取器，
// 体积多出约 120KB。Codabar 没有校验位、误识别率高，ZXing 默认也将其禁用。
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
// 缩小后仍可识别，但大图的逐行扫描会明显拖慢失败场景下的兜底速度。
const BARCODE_SCAN_DIMENSION = 1600;

// 扫描一维条形码：条形码印在平面上，灰度图已足够，无需像二维码那样尝试全部阈值图。
// 一维读取器会逐行二值化，因此只需要一种二值化方式。
// 竖拍的条形码在逐行扫描中会变成竖直条纹，因此再补一张顺时针旋转 90 度的图。
function decodeBarcodeWithZXing(gray: GrayImage): string | null {
    const scaled = downscaleGrayToMaxDimension(gray, BARCODE_SCAN_DIMENSION);

    for (const candidate of [scaled, rotateGray90(scaled)]) {
        const text = decodeOneDWithZXing(candidate);
        if (text) return text;
    }
    return null;
}

// 行扫描只处理水平方向，因此一维识别只需要灰度图和一种二值化方式。
function decodeOneDResultWithZXing(gray: GrayImage): Result | null {
    try {
        return oneDReader.decode(createZXingBitmap(gray), oneDHints);
    } catch {
        return null;
    }
}

function decodeOneDWithZXing(gray: GrayImage): string | null {
    return decodeOneDResultWithZXing(gray)?.getText() || null;
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

// 用 ZXing 识别单一灰度候选图，结果中带有定位点，批量识别据此遮罩已找到的区域。
function decodeQrResultWithZXing(gray: GrayImage): Result | null {
    try {
        return qrReader.decode(createZXingBitmap(gray), zxingHints);
    } catch {
        return null;
    }
}

function decodeQrWithZXing(gray: GrayImage): string | null {
    return decodeQrResultWithZXing(gray)?.getText() || null;
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

// 生成反色灰度图，用于识别白码黑底的二维码。
function invertGray(gray: GrayImage): GrayImage {
    const data = new Uint8ClampedArray(gray.data.length);
    for (let index = 0; index < data.length; index++) {
        data[index] = 255 - (gray.data[index] ?? 0);
    }
    return { data, width: gray.width, height: gray.height };
}

// 对黑色像素进行方形邻域膨胀。
// 圆点型二维码的模块之间有间隙，轻微膨胀可帮助 ZXing 连接模块并识别定位点。
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

// 二维码候选图，按命中概率排序。
// 普通二维码在灰度图就能识别；拍摄发光的屏幕或广告牌时二维码往往过曝，
// 用较高阈值能保留亮部区域的黑白对比；反色图兼容白码黑底；
// 圆点型二维码需要先膨胀再识别。
function* createQrCandidates(gray: GrayImage): Generator<GrayImage> {
    yield gray;

    for (const threshold of [192, 160, 128, 96, 224]) {
        yield thresholdGray(gray, threshold);
    }

    yield invertGray(gray);

    for (const threshold of [160, 192]) {
        yield dilateBlackPixels(thresholdGray(gray, threshold), 1);
    }
}

// ---------------------------- 批量识别 ----------------------------

// 批量识别的规模上限: 结果数、定位点数量与三角组合的尝试次数。
// 批量模式由用户显式触发, 但仍需限流, 避免密集二维码图片让耗时失控。
const MULTI_MAX_RESULTS = 20;
const MULTI_MAX_BARCODE_PASS = 8;
// 彩色标签的灰度值分布差异很大: 白底标签的条码靠原图即可识别,
// 红/绿色底的低对比度条码往往需要较低的固定阈值才能分离出黑条。
const BARCODE_THRESHOLDS = [48, 64];
const MULTI_MAX_FINDER_CENTERS = 30;
const MULTI_MAX_DECODE_ATTEMPTS = 1200;
const MULTI_MAX_CANDIDATES = 4;

// 让出主线程, 使批量识别的长计算不会冻结 popup 或页面。
const yieldToMainThread = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type LocatedResult = DecodeResult & { x: number; y: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 识别一张图片中的所有二维码和条形码。
// 二维码一次扫描整张图收集全部定位点, 再对定位点三角组合逐个解码,
// 因此并排、堆叠或混排的多个码都能找到; 条形码则通过遮罩逐轮找出。
export async function decodeAllFromImageData(imageData: ImageData): Promise<DecodeResult[]> {
    const gray = toGrayImage(imageData);
    const found: LocatedResult[] = [];
    const seen = new Set<string>();

    const add = (result: DecodeResult, x: number, y: number) => {
        if (!result.text || found.length >= MULTI_MAX_RESULTS) return;
        const key = `${result.kind}:${result.text}`;
        if (seen.has(key)) return;
        seen.add(key);
        found.push({ ...result, x, y });
    };

    // 一维条形码先扫: 与单码流程保持一致, 命中时更省时间。
    for (const text of decodeAllBarcodesWithZXing(gray)) {
        add({ text, kind: 'barcode' }, 0, 0);
    }
    await yieldToMainThread();

    let candidateIndex = 0;
    for (const candidate of createMultiQrCandidates(gray)) {
        if (found.length >= MULTI_MAX_RESULTS || candidateIndex >= MULTI_MAX_CANDIDATES) break;

        const codes = decodeMultipleQrWithZXing(candidate);
        if (codes.length) {
            for (const code of codes) {
                const bounds = code.bounds;
                add(
                    { text: code.text, kind: 'qr' },
                    bounds ? (bounds.minX + bounds.maxX) / 2 : 0,
                    bounds ? (bounds.minY + bounds.maxY) / 2 : 0,
                );
            }
        } else {
            // 定位点检测失败时退回单码识别, 兼容彩色、圆点等特殊码面。
            const fallback = decodeQrResultWithZXing(candidate);
            const text = fallback?.getText() ?? '';
            if (fallback && text) {
                const bounds = getResultBounds(fallback, candidate.width, candidate.height);
                add(
                    { text, kind: 'qr' },
                    bounds ? (bounds.minX + bounds.maxX) / 2 : 0,
                    bounds ? (bounds.minY + bounds.maxY) / 2 : 0,
                );
            }
        }

        candidateIndex++;
        await yieldToMainThread();
    }

    // 按从上到下、从左到右的顺序展示。
    found.sort((a, b) => a.y - b.y || a.x - b.x);
    return found.map(({ text, kind }) => ({ text, kind }));
}

// 批量模式的整图候选, 按命中概率排序; 候选过多时优先处理最常见的几种。
function* createMultiQrCandidates(gray: GrayImage): Generator<GrayImage> {
    yield gray;
    yield thresholdGray(gray, 160);
    yield invertGray(gray);
    yield dilateBlackPixels(thresholdGray(gray, 160), 1);
}

// ZXing 的 QRCodeReader 只支持单码: 图片中出现多个码时, 它可能把不同码的定位点
// 组合在一起, 导致整图识别失败。这里改为一次收集所有定位点, 再枚举 plausible 的
// 三角组合逐个解码, 相当于补上官方 MultiDetector 的能力。
function decodeMultipleQrWithZXing(gray: GrayImage): { text: string; bounds: Bounds | null }[] {
    const bitmap = createHybridBitmap(gray);
    const matrix = bitmap.getBlackMatrix();
    const finder = new FinderPatternFinder(matrix, noopResultPointCallback) as unknown as MultiFinderPatternFinder;

    // 单码查找器凑够三个定位点就会停止; 批量识别要扫描完整张图。
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
                    results.push({
                        text,
                        bounds: getPointBounds(detected.getPoints(), gray.width, gray.height),
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

// 批量识别使用 HybridBinarizer: 它按局部区域取阈值, 在二维码只占画面一小部分时
// 比全局直方图更稳定。
function createHybridBitmap(gray: GrayImage): BinaryBitmap {
    const { data, width, height } = gray;
    const source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
    return new BinaryBitmap(new HybridBinarizer(source));
}

// ZXing 的定位点查找器和检测器把关键方法声明为 private/protected,
// 这里用交叉类型会与原有声明冲突, 因此单独描述批量识别需要用到的方法。
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

// 逐个找出条形码: 一维结果只给出扫描行上的两个点, 因此需要随轮次增大竖直遮罩范围,
// 直到同一个条形码被彻底遮住, 才能继续找到下一个。
function decodeAllBarcodesWithZXing(gray: GrayImage): string[] {
    const scaled = downscaleGrayToMaxDimension(gray, BARCODE_SCAN_DIMENSION);
    const texts: string[] = [];
    const seen = new Set<string>();

    // 原图识别后保留遮罩结果: 已找到的条形码在后续阈值图中保持空白,
    // 既能减少重复命中, 也能避免彩色背景在阈值下被误读成新的码。
    const maskedImages = [scaled, rotateGray90(scaled)].map((base) =>
        scanBarcodesWithMasking(cloneGray(base), texts, seen));

    // 只有原图已经找到条形码时才尝试阈值图:
    // 彩色标签上的黑色条码灰度对比度可能不足, 阈值化后能找到同图中其余低对比度的码;
    // 完全不包含条形码的图片可以跳过这些额外扫描, 保持常规识别的速度。
    if (texts.length) {
        for (const masked of maskedImages) {
            for (const threshold of BARCODE_THRESHOLDS) {
                scanBarcodesWithMasking(thresholdGray(masked, threshold), texts, seen);
            }
        }
    }

    return texts;
}

function scanBarcodesWithMasking(gray: GrayImage, texts: string[], seen: Set<string>): GrayImage {
    for (let pass = 0; pass < MULTI_MAX_BARCODE_PASS; pass++) {
        const result = decodeOneDResultWithZXing(gray);
        const text = result?.getText() ?? '';
        const bounds = result ? getResultBounds(result, gray.width, gray.height) : null;
        if (!text || !bounds) break;

        if (!seen.has(text)) {
            seen.add(text);
            texts.push(text);
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

// 将包围盒区域涂成白色, 模拟"抹掉"已识别的码。
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
export async function getImageDataFromImageElement(img: HTMLImageElement): Promise<ImageData> {
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
