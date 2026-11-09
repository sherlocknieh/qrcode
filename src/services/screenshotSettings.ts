// 截图框选界面的显示模式(浮窗/全屏)与其入场动画, 存于 local, 由截图界面读写
// 键名沿用早期只控制入场动画时的写法, 保持已保存的设置继续生效
export const SCREENSHOT_INTRO_KEY = 'screenshotIntroEnabled';

// 未设置时默认开启(浮窗模式)
// 截图浮层一挂上就要用它, 读到内存里存着, 后续打开不再等一次存储往返
let introEnabled: boolean | undefined;

export async function getScreenshotIntroEnabled(): Promise<boolean> {
    if (introEnabled !== undefined) return introEnabled;
    const stored = await browser.storage.local.get(SCREENSHOT_INTRO_KEY);
    introEnabled = stored?.[SCREENSHOT_INTRO_KEY] !== false;
    return introEnabled;
}

// true 为浮窗模式, false 为全屏模式
export async function setScreenshotIntroEnabled(enabled: boolean): Promise<void> {
    introEnabled = enabled;
    await browser.storage.local.set({ [SCREENSHOT_INTRO_KEY]: enabled });
}
