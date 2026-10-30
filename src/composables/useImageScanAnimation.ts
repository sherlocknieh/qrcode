import { createApp, h, reactive, type App } from 'vue';
import ImageScanOverlay from '@/components/ImageScanOverlay.vue';

// 与 ImageScanOverlay 的动画时长保持一致: 60ms 延迟 + 640ms 扫过
const SWEEP_DURATION = 700;
const FADE_OUT_DURATION = 200;

export type ScanRect = { x: number; y: number; width: number; height: number };

type ScanState = ScanRect & { leaving: boolean };
type ScanSession = { host: HTMLDivElement; app: App; state: ScanState };

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// 网页图片识别时在图片区域播放扫描动画, play 在动画播完并淡出后才 resolve
export function useImageScanAnimation() {
    let session: ScanSession | undefined;

    const dispose = (current: ScanSession) => {
        current.app.unmount();
        current.host.remove();
    };

    const play = async (rect: ScanRect): Promise<void> => {
        if (session) return;

        const host = document.createElement('div');
        host.style.display = 'contents';
        document.body.appendChild(host);
        const state = reactive<ScanState>({ ...rect, leaving: false });
        const app = createApp({ render: () => h(ImageScanOverlay, state) });
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
    const cancel = () => {
        const current = session;
        if (!current) return;
        session = undefined;
        current.state.leaving = true;
        window.setTimeout(() => dispose(current), FADE_OUT_DURATION);
    };

    return { play, cancel };
}
