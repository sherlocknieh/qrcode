import { createApp, type App } from 'vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { getScreenshotIntroEnabled } from '@/services/screenshotSettings';

// 截图结果带上选区位置 (视口 CSS 像素) 与截图时的视口尺寸;
// 扫描后要按它们把码标在截图浮层上
export type ScreenshotCapture = {
    dataUrl: string;
    rect: ScanRect;
    viewport: { width: number; height: number };
};

// 取消时静默 (用户主动放弃, 不需要提示), 因此只有失败需要调用方处理
export type ScreenshotResult =
    | { type: 'failed' }
    | { type: 'cancelled' };

// 确认选区后的截图会话: 浮层继续留着当结果底图, 由调用方决定何时收起
export type ScreenshotSession = ScreenshotCapture & {
    // 扫描命中: 在冻结的截图上标出码的蓝框
    showResults(marks: ScanRect[]): void;
    // 收起浮层, 回到页面
    close(): void;
};

type StartOptions = {
    // 点中蓝框上的蓝点: 由调用方把通知切到该码
    onPick?(index: number): void;
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
    const startScreenshot = async (options: StartOptions = {}): Promise<ScreenshotSession> => {
        const [src, intro] = await Promise.all([
            captureVisibleTab(),
            getScreenshotIntroEnabled().catch(() => false),
        ]);

        return new Promise<ScreenshotSession>((resolve, reject) => {
            const host = document.createElement('div');
            host.style.display = 'contents';
            document.body.appendChild(host);

            let app: App | undefined;
            let overlay: InstanceType<typeof ScreenshotOverlay> | undefined;
            let settled = false;
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

            // 取消/失败: 还没确认就回绝调用方; 已确认时 (用户关掉冻结的截图) 只收起浮层
            const fail = (result: ScreenshotResult) => {
                if (!settled) {
                    settled = true;
                    reject(result);
                }
                dispose();
            };

            app = createApp(ScreenshotOverlay, {
                src,
                intro,
                onConfirm: (payload: ScreenshotCapture) => {
                    if (settled) return;
                    settled = true;
                    // 框选确认后浮层不卸载: 扫描期间截图继续铺在页面上, 蓝框随后标上去
                    resolve({
                        ...payload,
                        showResults: (marks: ScanRect[]) => overlay?.showResults(marks, payload.viewport),
                        close: dispose,
                    });
                },
                onPick: (index: number) => options.onPick?.(index),
                onCancel: () => fail({ type: 'cancelled' }),
                onError: () => fail({ type: 'failed' }),
            });
            overlay = app.mount(host) as unknown as InstanceType<typeof ScreenshotOverlay>;
        });
    };

    return { startScreenshot };
}
