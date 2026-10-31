// 截图框选界面的显示模式(浮窗/全屏)与其入场动画, 存于 local, 由截图界面读写
// 键名沿用早期只控制入场动画时的写法, 保持已保存的设置继续生效
export const SCREENSHOT_INTRO_KEY = 'screenshotIntroEnabled';

// 未设置时默认开启(浮窗模式)
export async function getScreenshotIntroEnabled(): Promise<boolean> {
    const stored = await browser.storage.local.get(SCREENSHOT_INTRO_KEY);
    return stored?.[SCREENSHOT_INTRO_KEY] !== false;
}

// true 为浮窗模式, false 为全屏模式
export async function setScreenshotIntroEnabled(enabled: boolean): Promise<void> {
    await browser.storage.local.set({ [SCREENSHOT_INTRO_KEY]: enabled });
}
