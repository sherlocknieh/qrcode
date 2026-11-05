// 与后台/其他入口通信的统一封装。
// 使用 Promise 形式并统一处理 runtime.lastError, 避免各处重复写回调包装。

type MessageResponse = { success?: boolean; error?: string };

// 发送消息并返回响应; 通信失败或 success === false 时抛错
export async function sendMessage<T>(
    action: string,
    payload: Record<string, unknown> = {},
): Promise<T & MessageResponse> {
    let response: (T & MessageResponse) | undefined;
    try {
        response = await browser.runtime.sendMessage({ action, ...payload });
    } catch (error) {
        // 后台未响应 (消息端口关闭) 时统一转成 Error
        throw toError(error, 'Background did not respond.');
    }
    if (!response?.success) {
        throw new Error(response?.error || 'Request failed.');
    }
    return response as T & MessageResponse;
}

// 发送消息但允许失败, 用于"尽力而为"的请求
export async function trySendMessage(
    action: string,
    payload: Record<string, unknown> = {},
): Promise<MessageResponse | undefined> {
    try {
        return await browser.runtime.sendMessage({ action, ...payload });
    } catch {
        return undefined;
    }
}

// 后台向指定标签页的内容脚本下发动作, 返回内容脚本是否在线.
// 注入不了内容脚本的页面 (扩展商店页、Firefox 内置 PDF 阅读器、独立 SVG 等) 发送会抛错,
// 这里统一折成 false, 由调用方决定退到扩展页还是 popup
export async function sendTabAction(
    tabId: number | undefined,
    action: string,
    payload: Record<string, unknown> = {},
): Promise<boolean> {
    if (tabId == null) return false;
    try {
        const response = await browser.tabs.sendMessage(
            tabId,
            { action, ...payload },
        ) as MessageResponse | undefined;
        return response?.success !== false;
    } catch {
        return false;
    }
}

// 右键菜单与部分消息不带标签页 (Firefox 的 popup 不是标签页), 统一取当前活动标签页兜底;
// TAB_ID_NONE(-1) 是 devtools / app 这类没有标签页的宿主, 同样当作"没有"处理
export async function resolveActiveTabId(tabId?: number): Promise<number | undefined> {
    if (tabId != null && tabId >= 0) return tabId;
    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
    return activeTab?.id;
}

function toError(error: unknown, fallback: string): Error {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error) return new Error(error);
    return new Error(fallback);
}
