import { createApp, h, reactive, type App } from 'vue';
import ScanOverlay, { type ScanRect } from '@/components/ScanOverlay.vue';

// 扫过动画默认时长; 与 ScanOverlay 的 CSS 变量保持一致
const DEFAULT_SWEEP_DURATION = 700;
// 与 ScanOverlay 的淡出动画时长保持一致
const FADE_OUT_DURATION = 200;
// 光带启动延迟 (CSS animation-delay)
const SWEEP_DELAY = 80;

type ScanOptions = {
    // 不传表示整屏扫描; 传入矩形只覆盖该区域
    rect?: ScanRect;
    duration?: number;
};

type ScanState = ScanOptions & { leaving: boolean };
type ScanSession = { host: HTMLDivElement; app: App; state: ScanState };

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// 扫描动画: 截图/图片数据就绪后才挂载, 避免动画被截进图片;
// play() 在扫过并淡出后才 resolve, 调用方据此延后弹窗
export function useScanAnimation() {
    let session: ScanSession | undefined;

    const dispose = (current: ScanSession) => {
        current.app.unmount();
        current.host.remove();
    };

    const play = async (options: ScanOptions = {}): Promise<void> => {
        if (session) return;

        const host = document.createElement('div');
        host.style.display = 'contents';
        document.body.appendChild(host);
        const state = reactive<ScanState>({ ...options, leaving: false });
        const app = createApp({
            render: () => h(ScanOverlay, {
                rect: state.rect ?? null,
                duration: state.duration ?? DEFAULT_SWEEP_DURATION,
                leaving: state.leaving,
            }),
        });
        app.mount(host);
        const current: ScanSession = { host, app, state };
        session = current;

        await delay((options.duration ?? DEFAULT_SWEEP_DURATION) + SWEEP_DELAY);
        if (session !== current) return;
        current.state.leaving = true;
        await delay(FADE_OUT_DURATION);
        if (session !== current) return;
        session = undefined;
        dispose(current);
    };

    // 识别被取消或出错时提前收起动画
    const stop = () => {
        const current = session;
        if (!current) return;
        session = undefined;
        current.state.leaving = true;
        window.setTimeout(() => dispose(current), FADE_OUT_DURATION);
    };

    return { play, stop };
}
