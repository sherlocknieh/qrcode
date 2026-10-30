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

export function toError(error: unknown, fallback: string): Error {
    if (error instanceof Error) return error;
    if (typeof error === 'string' && error) return new Error(error);
    return new Error(fallback);
}
