import { createApp, type App } from 'vue';
import ScreenshotOverlay from '@/components/ScreenshotOverlay.vue';
import { getScreenshotIntroEnabled } from '@/services/screenshotSettings';

// 取消时静默 (用户主动放弃, 不需要提示), 因此只有失败需要调用方处理
export type ScreenshotResult =
    | { type: 'failed' }
    | { type: 'cancelled' };

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
    const startScreenshot = async (): Promise<string> => {
        const [src, intro] = await Promise.all([
            captureVisibleTab(),
            getScreenshotIntroEnabled().catch(() => false),
        ]);

        return new Promise<string>((resolve, reject) => {
            const host = document.createElement('div');
            host.style.display = 'contents';
            document.body.appendChild(host);

            let app: App | undefined;
            let settled = false;

            // 组件自身的点击回调里同步卸载会中断渲染, 放到微任务中执行
            const dispose = () => {
                queueMicrotask(() => {
                    app?.unmount();
                    host.remove();
                });
            };

            const finish = (action: () => void) => {
                if (settled) return;
                settled = true;
                action();
                dispose();
            };

            app = createApp(ScreenshotOverlay, {
                src,
                intro,
                onConfirm: (dataUrl: string) => finish(() => resolve(dataUrl)),
                onCancel: () =>
                    finish(() => reject({ type: 'cancelled' } satisfies ScreenshotResult)),
                onError: () => finish(() => reject({ type: 'failed' } satisfies ScreenshotResult)),
            });
            app.mount(host);
        });
    };

    return { startScreenshot };
}
