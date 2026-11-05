import type { ScanRect } from '@/components/ScanOverlay.vue';
import { toMarkRects } from '@/composables/useCodePicker';
import { useScreenshot, type ScreenshotCapture, type ScreenshotSession } from '@/composables/useScreenshot';
import type { DecodeOutcome } from '@/services/recognize';
import type { DecodeResult } from '@/services/qrScanner';

// 截图扫描: 一张截图 + 框选/整屏 → 解码 → 在冻结的截图上标蓝点, 点选逐条出结果。
// 全屏扫描就是"自动对整屏框选一次", 与用户手动框选共用同一条流程;
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
    // 初次结果: 单条弹通知, 多条按宿主策略处理 (有蓝点时通常不弹)
    notifyResults(results: DecodeResult[]): Promise<unknown>;
    // 点中蓝点后展示这一条结果
    notifyPicked(result: DecodeResult): Promise<unknown>;
    // 截图读取失败
    onError?(): void;
    // 用户主动收起截图 (关闭按钮 / ESC / 点外部)
    onClose?(): void;
    // 只读结果层点了空白处
    onBlank?(): void;
    // 结果变化, 通知结束时据此判断要不要收起截图:
    // count 是画面上还能点的结果数, picked 表示这次变化来自点选, ok 表示本次扫描是否成功,
    // selectable 表示这次是不是可框选的截图工具 (只读结果层失败后没有继续框选的入口)
    onResultsChanged?(state: { count: number; picked: boolean; ok: boolean; selectable: boolean }): void;
};

export function useScreenshotScan(options: ScreenshotScanOptions) {
    const { startScreenshot } = useScreenshot();
    let session: ScreenshotSession | null = null;
    let results: DecodeResult[] = [];
    // 框选轮次: 前一轮异步结果不能覆盖后一轮画面
    let seq = 0;
    // 每次打开截图会话递增: 上一张截图里的异步结果不再影响新画面
    let epoch = 0;
    // 当前这层是可框选的截图工具, 还是只展示结果的只读层
    let selectable = true;

    function setResults(next: DecodeResult[], picked: boolean, ok = true) {
        results = next;
        options.onResultsChanged?.({ count: next.length, picked, ok, selectable });
    }

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
            setResults([], false, false);
            return;
        }
        // 蓝框只标可定位的码, 点选按下标取结果时两边要保持同一份列表
        const located = outcome.results.filter((result) => result.bounds);
        current.showResults(toMarkRects(located, {
            rect: capture.rect,
            imageSize: outcome.imageSize,
            scroll: { x: 0, y: 0 },
            viewportWidth: capture.viewport.width,
            followScroll: false,
            clip: capture.rect,
        }));
        setResults(located, false);
        await options.notifyResults(outcome.results);
    }

    // 打开截图扫描: src 复用已截好的视口图; autoCapture 表示打开后立即整屏扫描
    async function open(params: {
        src?: string;
        autoCapture?: ScreenshotScanCapture;
        selectable?: boolean;
    } = {}): Promise<boolean> {
        close();
        const currentEpoch = epoch;
        results = [];
        // 全屏扫描只需要结果展示, 默认不给框选与工具按钮; 手动框选入口保留完整截图工具
        selectable = params.selectable ?? !params.autoCapture;
        try {
            const opened = await startScreenshot({
                src: params.src,
                // 整屏自动扫描不播入场动画, 否则收缩动画会和扫描光带叠在一起
                intro: params.autoCapture ? false : undefined,
                selectable,
                onBlank: () => options.onBlank?.(),
                onPick: (index) => {
                    const result = results[index];
                    if (!result) return;
                    // 先更新剩余结果 (宿主据此决定关通知时是否收尾), 再投递这一条结果
                    setResults(results.filter((_, resultIndex) => resultIndex !== index), true);
                    session?.removeResult(index);
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

    // 画面上还没点过的结果数: 通知结束时用它判断是否要收起截图
    const remaining = () => results.length;

    return { open, close, remaining };
}
