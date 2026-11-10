// 优先使用内存态的 session 存储, 不可用时回退 local
export const storageArea = () => browser.storage.session ?? browser.storage.local;

// popup 的 storage.onChanged 需要按当前实际使用的区域过滤
export const storageAreaName = () => (browser.storage.session ? 'session' : 'local');

// 读取临时值后立即清除, 避免残留内容污染下一次扫描。
// 只有真的读到值才删: 截图页与截屏并行时, 读空之后后台可能刚好写入, 无条件删除会把新图删掉
export async function takeStoredValue(key: string): Promise<unknown> {
    const area = storageArea();
    const result = await area.get(key);
    const value = result?.[key];
    if (value !== undefined) await area.remove(key).catch(() => {});
    return value;
}

// 读取临时字符串后立即清除
export async function takeStoredString(key: string): Promise<string> {
    const value = await takeStoredValue(key);
    return typeof value === 'string' && value ? value : '';
}
