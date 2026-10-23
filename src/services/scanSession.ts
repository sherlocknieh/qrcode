// 本地识别页交给 popup 识别时, 在 session 存储中记录发起识别的标签页 ID,
// 识别结束后由 popup 关闭该标签页; popup 不可用时回退到 local 存储
export const QR_SCAN_TAB_KEY = 'qrScanTabId';

const storageArea = () => browser.storage.session ?? browser.storage.local;

export async function rememberScanTab(tabId?: number) {
    if (tabId == null) return;
    await storageArea().set({ [QR_SCAN_TAB_KEY]: tabId });
}

// 读取并清除标签页 ID, 避免残留值影响后续识别
export async function takeScanTabId(): Promise<number | null> {
    const area = storageArea();
    try {
        const result = await area.get(QR_SCAN_TAB_KEY);
        const value = result?.[QR_SCAN_TAB_KEY];
        return typeof value === 'number' ? value : null;
    } finally {
        await area.remove(QR_SCAN_TAB_KEY).catch(() => {});
    }
}
