// 复制文本到剪贴板, 返回是否成功; 成功提示由通知按钮自行展示。
// 不使用 clipboardWrite 权限: 调用都发生在点击回调里 (用户手势),
// Clipboard API 不可用时回退到 execCommand, 全程不需要声明权限。
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return copyTextFallback(text);
    }
}

// 传统复制方式: 借助隐藏的 textarea 选中后执行 copy 命令
function copyTextFallback(text: string): boolean {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand('copy');
        textarea.remove();
        return success;
    } catch {
        return false;
    }
}
