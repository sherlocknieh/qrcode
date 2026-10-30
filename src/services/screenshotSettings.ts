// 截图框选界面的入场动画开关, 存于 local, 供后台菜单与各入口读取
export const SCREENSHOT_INTRO_KEY = 'screenshotIntroEnabled';

// 未设置时默认开启
export async function getScreenshotIntroEnabled(): Promise<boolean> {
    const stored = await browser.storage.local.get(SCREENSHOT_INTRO_KEY);
    return stored?.[SCREENSHOT_INTRO_KEY] !== false;
}

export async function setScreenshotIntroEnabled(enabled: boolean): Promise<void> {
    await browser.storage.local.set({ [SCREENSHOT_INTRO_KEY]: enabled });
}
