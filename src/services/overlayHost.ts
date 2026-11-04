// 扫码叠加层(扫描动画 / 命中蓝框)都贴在图片上, 但挂在 body 上时只能靠抬高 z-index 压过图片,
// 结果连页面自己后出现的浮层一起盖住(如维基媒体查看器的下载面板), 压低又会被图片所在的浮层挡住。
// 因此优先挂进图片所在容器, 与图片同处一个层叠上下文并紧排在它之后, 只压住图片本身。
// 祖先若把 fixed 的定位参照改掉(transform/filter 等), 挂进去会让坐标整体错位, 只能退回 body
export function overlayMountPoint(anchor?: Element | null): HTMLElement {
    const parent = anchor?.isConnected ? anchor.parentElement : null;
    if (!parent) return document.body;
    for (let node: Element | null = parent; node; node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (breaksFixedPosition(getComputedStyle(node))) return document.body;
    }
    return parent;
}

// 图片自身是带 z-index 的定位元素时才需要再高一层; 其余情况靠"排在图片之后"就够了
export function overlayZIndex(anchor?: Element | null): number | null {
    if (!anchor) return null;
    const style = getComputedStyle(anchor);
    if (style.position === 'static' || style.zIndex === 'auto') return null;
    const zIndex = Number.parseInt(style.zIndex, 10);
    return Number.isFinite(zIndex) ? zIndex + 1 : null;
}

// 会让后代 fixed 元素改为相对自身定位的属性, 出现任何一种都不能把叠加层挂到该子树里
function breaksFixedPosition(style: CSSStyleDeclaration): boolean {
    if (style.transform !== 'none' || style.filter !== 'none' || style.perspective !== 'none') return true;
    if (style.backdropFilter !== 'none') return true;
    if (/paint|layout|strict|content/.test(style.contain)) return true;
    return /transform|filter|perspective/.test(style.willChange);
}
