import type { ScanRect } from '@/components/ScanOverlay.vue';
import { toMarkRects } from '@/composables/useCodePicker';
import { useScreenshot, type ScreenshotCapture, type ScreenshotSession } from '@/composables/useScreenshot';
import type { DecodeOutcome } from '@/services/recognize';
import type { DecodeResult } from '@/services/qrScanner';

// 截图扫描: 一张截图 + 框选/整屏 → 解码 → 在冻结的截图上标绿点, 点选逐条出结果。
// 全屏扫描就是"自动对整屏框选一次", 与用户手动框选共用同一条流程,
// 扫完还能接着拖框重扫, 单击 (没拖出选区) 才退出;
// 内容脚本与独立扫描页都走这里, 不再各写一套截图承载逻辑。
export type ScreenshotScanCapture = ScreenshotCapture;

export type ScreenshotScanContext = {
    // 选区在视口中的位置: 浮层可能缩成浮窗, 扫描动画按视口定位
    rect: ScanRect;
    // 本次扫描是否已被新的框选/新一轮扫描取代
    isStale(): boolean;
};

type ScreenshotScanOptions = {
    // 解码一块截图; 播放扫描动画、错误提示与无结果通知都由调用方决定
    decode(capture: ScreenshotScanCapture, context: ScreenshotScanContext): Promise<DecodeOutcome>;
    // 初次结果: 单条弹结果通知, 多条弹一条"扫到多个码"的轻提示 (由宿主的 notifyResults 决定)
    notifyResults(results: DecodeResult[]): Promise<unknown>;
    // 点中绿点后展示这一条结果
    notifyPicked(result: DecodeResult): Promise<unknown>;
    // 截图读取失败
    onError?(): void;
    // 用户主动收起截图 (单击 / ESC / 点外部)
    onClose?(): void;
    // 单击 (没拖出选区) 视为退出, 通知还开着时由宿主忽略
    onBlank?(): void;
};

export function useScreenshotScan(options: ScreenshotScanOptions) {
    const { startScreenshot } = useScreenshot();
    let session: ScreenshotSession | null = null;
    // 本轮结果: 点选按下标取结果时, 与画面上那份绿框列表保持同一顺序
    let results: DecodeResult[] = [];
    // 框选轮次: 前一轮异步结果不能覆盖后一轮画面
    let seq = 0;
    // 每次打开截图会话递增: 上一张截图里的异步结果不再影响新画面
    let epoch = 0;

    // 对截图上的一块 (整屏也走这里) 解码并把结果标回画面
    async function scan(capture: ScreenshotScanCapture) {
        const current = session;
        if (!current) return;
        const currentEpoch = epoch;
        const currentSeq = ++seq;
        results = [];
        const outcome = await options.decode(capture, {
            // 扫描动画在页面上按视口定位, 浮窗模式下要把选区换算出去
            rect: current.toViewportRect(capture.rect),
            isStale: () => currentEpoch !== epoch || currentSeq !== seq,
        });
        if (currentEpoch !== epoch || currentSeq !== seq || session !== current) return;
        if (outcome.status !== 'ok') {
            // 没扫到或出错: 留住截图, 并保留这次的挖空范围 (整屏扫描就是整个画面),
            // 用户能看清刚才扫的是哪一块, 接着框选重扫
            current.clearResults(capture.rect);
            results = [];
            return;
        }
        // 绿框只标可定位的码, 点选按下标取结果时两边要保持同一份列表
        const located = outcome.results.filter((result) => result.bounds);
        current.showResults(toMarkRects(located, {
            rect: capture.rect,
            imageSize: outcome.imageSize,
            scroll: { x: 0, y: 0 },
            viewportWidth: capture.viewport.width,
            followScroll: false,
            clip: capture.rect,
        }));
        results = located;
        await options.notifyResults(outcome.results);
    }

    // 打开截图扫描: src 复用已截好的视口图; autoCapture 表示打开后立即整屏扫描
    async function open(params: {
        src?: string;
        autoCapture?: ScreenshotScanCapture;
    } = {}): Promise<boolean> {
        close();
        const currentEpoch = epoch;
        try {
            const opened = await startScreenshot({
                src: params.src,
                // 整屏自动扫描不播入场动画, 否则收缩动画会和扫描光带叠在一起
                intro: params.autoCapture ? false : undefined,
                onBlank: () => options.onBlank?.(),
                onPick: (index) => {
                    const result = results[index];
                    if (!result) return;
                    // 摘掉这个码的圆点 (绿框留着标出已经看过), 再投递这一条结果
                    session?.markPicked(index);
                    void options.notifyPicked(result);
                },
                onCapture: (capture) => void scan(capture),
                onError: () => options.onError?.(),
                onClose: () => {
                    // 用户自己收起截图: 清掉本轮结果, 后续通知结束不再尝试关闭已卸载的浮层
                    if (currentEpoch !== epoch) return;
                    epoch++;
                    seq++;
                    results = [];
                    session = null;
                    options.onClose?.();
                },
            });
            if (currentEpoch !== epoch) {
                opened.close();
                return false;
            }
            session = opened;
            if (params.autoCapture) await scan(params.autoCapture);
            return true;
        } catch {
            options.onError?.();
            return false;
        }
    }

    function close() {
        epoch++;
        seq++;
        results = [];
        session?.close();
        session = null;
    }

    return { open, close };
}
