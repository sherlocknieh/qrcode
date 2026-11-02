import { createApp, h, type App } from 'vue';
import ScanPanel from '@/components/ScanPanel.vue';
import { trySendMessage } from '@/services/messaging';

// 页面内浮层宿主: 与独立识别页共用 ScanPanel, 只负责挂载/卸载。
// 与截图框选的 useScreenshot 同一套思路: 组件自带遮罩, 宿主只处理生命周期
export function useImagePasteOverlay() {
    let host: HTMLDivElement | undefined;
    let app: App | undefined;

    const close = () => {
        const currentApp = app;
        const currentHost = host;
        app = undefined;
        host = undefined;
        // 组件自身的点击回调里同步卸载会中断渲染, 放到微任务中执行
        queueMicrotask(() => {
            currentApp?.unmount();
            currentHost?.remove();
        });
    };

    const open = () => {
        if (app) return;
        const element = document.createElement('div');
        element.style.display = 'contents';
        document.body.appendChild(element);
        host = element;
        app = createApp({
            render: () => h(ScanPanel, {
                variant: 'overlay',
                mode: 'image',
                onClose: close,
                // 浮层里直接开摄像头; 页面安全上下文/权限策略不允许时再升级到扩展页
                onCameraUnavailable: () => {
                    close();
                    void trySendMessage('openCameraScan');
                },
            }),
        });
        app.mount(element);
    };

    return { open, close };
}
