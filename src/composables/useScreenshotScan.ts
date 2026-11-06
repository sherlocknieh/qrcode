import type { ScanRect } from '@/components/ScanAnimation.vue';
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
    // 这次是不是"打开后自动整屏扫一次": 没扫到时要退回纯框选态并给出重入口
    fullScreen: boolean;
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
    // 最近一次打开用的截好图: 通知里点"尝试框选扫描"时用它重开被收起的截图层
    let lastSrc: string | undefined;

    // 对截图上的一块 (整屏也走这里) 解码并把结果标回画面
    async function scan(capture: ScreenshotScanCapture, fullScreen = false) {
        const current = session;
        if (!current) return;
        const currentEpoch = epoch;
        const currentSeq = ++seq;
        results = [];
        const outcome = await options.decode(capture, {
            // 扫描动画在页面上按视口定位, 浮窗模式下要把选区换算出去
            rect: current.toViewportRect(capture.rect),
            fullScreen,
            isStale: () => currentEpoch !== epoch || currentSeq !== seq,
        });
        if (currentEpoch !== epoch || currentSeq !== seq || session !== current) return;
        if (outcome.status !== 'ok') {
            // 没扫到或出错: 留住截图, 直接进入框选态等用户拖一块重扫。
            // 整屏扫描不留整屏选区 (否则拖哪都是在移动那块全覆盖的选区), 用户自己框的则留着,
            // 让他看清刚才扫的是哪一块, 接着拖下一块
            current.clearResults(fullScreen ? undefined : capture.rect);
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
        intro?: boolean;
    } = {}): Promise<boolean> {
        close();
        const currentEpoch = epoch;
        // 记下这张图: 通知里点"尝试框选扫描"时若截图层已被收起, 用它原样重开
        lastSrc = params.src;
        try {
            const opened = await startScreenshot({
                src: params.src,
                // 整屏自动扫描不播入场动画, 否则收缩动画会和扫描光带叠在一起
                intro: params.intro ?? (params.autoCapture ? false : undefined),
                onBlank: () => options.onBlank?.(),
                onPick: (index) => {
                    const result = results[index];
                    if (!result) return;
                    // 摘掉这个码的圆点 (绿框留着标出已经看过), 再投递这一条结果
                    session?.markPicked(index);
                    void options.notifyPicked(result);
                },
                onDismiss: () => {
                    // 点已经看过的灰框 / 单码框与点空白同一条收尾: 由宿主判断
                    // 这一下是消通知还是收起截图层 (独立扫描页则关掉标签页)
                    options.onBlank?.();
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
            if (params.autoCapture) await scan(params.autoCapture, true);
            return true;
        } catch {
            options.onError?.();
            return false;
        }
    }

    // 进入框选态: 现有截图层还开着就直接退回纯框选 (不重新截屏、不播入场动画);
    // 用户已经把截图层收起时才用上那张图重开一层
    async function frameScan(): Promise<boolean> {
        if (session) {
            session.clearResults();
            return true;
        }
        if (lastSrc) return open({ src: lastSrc, intro: false });
        return false;
    }

    function close() {
        epoch++;
        seq++;
        results = [];
        session?.close();
        session = null;
    }

    return { open, close, frameScan };
}
