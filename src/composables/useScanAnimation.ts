import { createApp, h, reactive, type App } from 'vue';
import ScanOverlay, { type ScanRect } from '@/components/ScanOverlay.vue';
import { overlayMountPoint, overlayZIndex } from '@/services/overlayHost';

// 扫过动画默认时长; 与 ScanOverlay 的 CSS 变量保持一致
const DEFAULT_SWEEP_DURATION = 700;
// 与 ScanOverlay 的淡出动画时长保持一致
const FADE_OUT_DURATION = 200;
// 光带启动延迟 (CSS animation-delay)
const SWEEP_DELAY = 80;
// 挂载后先等第一帧画出来, 再把主线程交给解码, 避免循环动画还没露面就被吃掉
const FIRST_FRAME_DELAY = 160;

type ScanOptions = {
    // 不传表示整屏扫描; 传入矩形只覆盖该区域
    rect?: ScanRect;
    duration?: number;
    // 区域扫描对应的图片元素: 用来算"只比它高一层"的层级
    anchor?: Element | null;
    // 盖在截图容器上播放时指定: 截图容器用的是最高层级, 光带要压过它才看得见
    zIndex?: number;
};

type ScanState = ScanOptions & { leaving: boolean };
type ScanSession = {
    host: HTMLDivElement;
    app: App;
    state: ScanState;
    // 至少显示这么久的扫过动画, 解码很快时不会一闪而过
    minVisibleMs: number;
    startedAt: number;
};

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// 扫描动画: 图片数据就绪后才挂载, 避免动画被截进图片;
// 光带在扫描期间一直循环扫过, play() 只等首帧就返回,
// stop() 负责收尾: 至少完整扫过一遍 → 淡出 → 卸载, 淡出结束后才 resolve
export function useScanAnimation() {
    let session: ScanSession | undefined;

    const dispose = (current: ScanSession) => {
        current.app.unmount();
        current.host.remove();
    };

    const play = async (options: ScanOptions = {}): Promise<void> => {
        if (session) return;

        const duration = options.duration ?? DEFAULT_SWEEP_DURATION;
        // 只在挂载时算一次: 动画淡出期间图片可能已被移除, 免得层级与挂载点中途变化
        const anchor = options.rect ? options.anchor : null;
        const mount = overlayMountPoint(anchor);
        // 挂进图片容器时才跟随页面层级; 退回 body 时保留覆盖视口的最高层,
        // 显式传了 zIndex (如盖在截图容器上) 时以它为准
        const zIndex = options.zIndex ?? (mount === document.body ? null : overlayZIndex(anchor));
        const host = document.createElement('div');
        host.style.display = 'contents';
        mount.appendChild(host);
        const state = reactive<ScanState>({ ...options, leaving: false });
        const app = createApp({
            render: () => h(ScanOverlay, {
                rect: state.rect ?? null,
                duration: state.duration ?? duration,
                zIndex,
                leaving: state.leaving,
            }),
        });
        app.mount(host);
        session = {
            host,
            app,
            state,
            minVisibleMs: duration + SWEEP_DELAY,
            startedAt: performance.now(),
        };

        await delay(FIRST_FRAME_DELAY);
    };

    // 扫描结束 (成功/无结果/出错/取消) 时收起动画, 返回的 Promise 在淡出结束后 resolve
    const stop = async (): Promise<void> => {
        const current = session;
        if (!current) return;
        session = undefined;

        const elapsed = performance.now() - current.startedAt;
        const wait = Math.max(0, current.minVisibleMs - elapsed);
        if (wait > 0) await delay(wait);
        current.state.leaving = true;
        await delay(FADE_OUT_DURATION);
        dispose(current);
    };

    return { play, stop };
}
