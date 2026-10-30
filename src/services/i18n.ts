// 统一的国际化文本读取: 缺失翻译时回退到 fallback, 未提供时回退到 key 本身
export function t(key: string, fallback?: string): string {
    return browser.i18n.getMessage(key as never) || fallback || key;
}
