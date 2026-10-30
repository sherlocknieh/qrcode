import { createApp, h, reactive, type App } from 'vue';
import QuickScanOverlay from '@/components/QuickScanOverlay.vue';

// 与 QuickScanOverlay 的动画时长保持一致: 80ms 延迟 + 700ms 扫过
const SWEEP_DURATION = 780;
const FADE_OUT_DURATION = 200;

type ScanState = { leaving: boolean };
type ScanSession = { host: HTMLDivElement; app: App; state: ScanState };

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// 一键截屏识别的整屏扫描动画: 截图完成后再挂载, 避免动画被截进图片;
// play() 在扫过并淡出后才 resolve, 调用方据此延后弹窗
export function useQuickScanAnimation() {
    let session: ScanSession | undefined;

    const dispose = (current: ScanSession) => {
        current.app.unmount();
        current.host.remove();
    };

    const play = async (): Promise<void> => {
        if (session) return;

        const host = document.createElement('div');
        host.style.display = 'contents';
        document.body.appendChild(host);
        const state = reactive<ScanState>({ leaving: false });
        const app = createApp({ render: () => h(QuickScanOverlay, state) });
        app.mount(host);
        const current: ScanSession = { host, app, state };
        session = current;

        await delay(SWEEP_DURATION);
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
