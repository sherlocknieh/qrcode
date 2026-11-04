import { createApp, type App } from 'vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { getScreenshotIntroEnabled } from '@/services/screenshotSettings';

// 截图结果带上选区在浮层显示区域中的位置与截图时的视口尺寸;
// 扫描后要按它们把码标在截图浮层上 (浮层显示区域与截图同比例, 蓝框层据此整体缩放)
export type ScreenshotCapture = {
    dataUrl: string;
    rect: ScanRect;
    viewport: { width: number; height: number };
};

// 取消时静默 (用户主动放弃, 不需要提示), 因此只有失败需要调用方处理
export type ScreenshotResult =
    | { type: 'failed' }
    | { type: 'cancelled' };

// 打开后的截图浮层: 每次框选都会回调 onCapture, 浮层要等调用方收起才消失
export type ScreenshotSession = {
    // 扫描命中: 在冻结的截图上标出码的蓝框
    showResults(marks: ScanRect[]): void;
    // 没扫到码: 清掉蓝框但留住截图, 让用户可以继续框选别的区域
    clearResults(): void;
    // 收起浮层, 回到页面
    close(): void;
};

type StartOptions = {
    // 每确认一次选区回调一次: 首次扫描与"再框一块"共用同一张截图
    onCapture(capture: ScreenshotCapture): void;
    // 点中蓝框上的蓝点: 由调用方把通知切到该码
    onPick?(index: number): void;
    // 截图读不出来, 由调用方提示失败
    onError?(): void;
};

type CaptureResponse = { success: true; dataUrl: string } | { success: false; error?: string };

// 使用 captureVisibleTab 获取当前视口图像。
async function captureVisibleTab(): Promise<string> {
    let response: CaptureResponse | undefined;
    try {
        response = await browser.runtime.sendMessage({ action: 'captureVisibleTab' });
    } catch {
        throw { type: 'failed' } satisfies ScreenshotResult;
    }
    if (!response?.success || !response.dataUrl) {
        throw { type: 'failed' } satisfies ScreenshotResult;
    }
    return response.dataUrl;
}

export function useScreenshot() {
    const startScreenshot = async (options: StartOptions): Promise<ScreenshotSession> => {
        const [src, intro] = await Promise.all([
            captureVisibleTab(),
            getScreenshotIntroEnabled().catch(() => false),
        ]);

        return new Promise<ScreenshotSession>((resolve) => {
            const host = document.createElement('div');
            host.style.display = 'contents';
            document.body.appendChild(host);

            let app: App | undefined;
            let overlay: InstanceType<typeof ScreenshotOverlay> | undefined;
            let disposed = false;

            // 组件自身的点击回调里同步卸载会中断渲染, 放到微任务中执行
            const dispose = () => {
                if (disposed) return;
                disposed = true;
                queueMicrotask(() => {
                    app?.unmount();
                    host.remove();
                });
            };

            app = createApp(ScreenshotOverlay, {
                src,
                intro,
                onConfirm: (payload: ScreenshotCapture) => options.onCapture(payload),
                onPick: (index: number) => options.onPick?.(index),
                onCancel: dispose,
                onError: () => {
                    options.onError?.();
                    dispose();
                },
            });
            overlay = app.mount(host) as unknown as InstanceType<typeof ScreenshotOverlay>;
            // 浮层一挂上就把会话交给调用方: 后续每次框选都由 onCapture 推进
            resolve({
                showResults: (marks: ScanRect[]) => overlay?.showResults(marks),
                clearResults: () => overlay?.clearResults(),
                close: dispose,
            });
        });
    };

    return { startScreenshot };
}
