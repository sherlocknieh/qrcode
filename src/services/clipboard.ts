// 复制文本到剪贴板, 返回是否成功; 成功提示由通知按钮自行展示
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // 复制失败时保持安静, 避免再叠一层通知
        return false;
    }
}
