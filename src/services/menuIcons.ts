// Firefox 右键菜单图标
// Firefox 只允许 chrome:// 资源使用 context-fill, 扩展图片会被忽略, 因此改用
// SVG 内部的 prefers-color-scheme 切换颜色: 深色主题白色, 浅色主题黑色。
// Chrome/Edge 不支持菜单图标, 不会使用这里的图标。

const icon = (id: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
    + `<style>:root{color:#111827}@media (prefers-color-scheme:dark){:root{color:#f3f4f6}}</style>`
    + `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">`
    + `<rect width="16" height="16" fill="#000"/>`
    + `<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
    + `</mask></defs>`
    + `<rect width="16" height="16" fill="currentColor" mask="url(#${id})"/>`
    + `</svg>`;

const MENU_ICONS = {
    // 扫描图片: 图片 + 放大镜
    scan: icon('scan',
        '<rect x="1.5" y="3" width="8.5" height="7.5" rx="1.2"/>'
        + '<path d="m2 9.4 2.2-2.2 1.7 1.7"/>'
        + '<circle cx="10.8" cy="9.8" r="2.3"/>'
        + '<path d="m12.5 11.5 1.9 1.9"/>'),
    // 文字 → 二维码: 文字 T
    text: icon('text',
        '<path d="M3 3h10"/>'
        + '<path d="M8 3v10"/>'
        + '<path d="M5.5 13h5"/>'),
    // 扫描区域: 选框四角 + 中心十字
    screenshot: icon('screenshot',
        '<path d="M2 5.5V3.5A1.5 1.5 0 0 1 3.5 2h2"/>'
        + '<path d="M10.5 2h2A1.5 1.5 0 0 1 14 3.5v2"/>'
        + '<path d="M14 10.5v2a1.5 1.5 0 0 1-1.5 1.5h-2"/>'
        + '<path d="M5.5 14h-2A1.5 1.5 0 0 1 2 12.5v-2"/>'
        + '<path d="M8 6.5v3M6.5 8h3"/>'),
    // 扫描屏幕: 显示器 + 扫描线
    scanFullScreen: icon('scanFullScreen',
        '<rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/>'
        + '<path d="M8 11.5v2"/>'
        + '<path d="M5.5 14h5"/>'
        + '<path d="M4.5 7h7"/>'),
    // 上传/粘贴图片: 剪贴板 + 图片
    image: icon('image',
        '<path d="M5.5 2.5h-1A1.5 1.5 0 0 0 3 4v8.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V4a1.5 1.5 0 0 0-1.5-1.5h-1"/>'
        + '<rect x="5.5" y="1.5" width="5" height="3" rx="1"/>'
        + '<circle cx="6.2" cy="7.5" r=".9"/>'
        + '<path d="m4 12.5 2-2 1.4 1.4 1.2-1.2 1.9 1.9"/>'),
    // 摄像头扫码: 相机机身 + 镜头
    camera: icon('camera',
        '<path d="M4.4 5.2 5.5 3.6A1 1 0 0 1 6.3 3h3.4a1 1 0 0 1 .8.6l1.1 1.6"/>'
        + '<rect x="1.5" y="5.2" width="13" height="8.8" rx="1.8"/>'
        + '<circle cx="8" cy="9.6" r="2.5"/>'),
    show: icon('show',
        '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8z"/>'
        + '<circle cx="8" cy="8" r="2"/>'),
    hide: icon('hide',
        '<path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4S1.5 8 1.5 8z"/>'
        + '<circle cx="8" cy="8" r="2"/>'
        + '<path d="M2.5 2.5l11 11"/>'),
} as const;

export type MenuIconName = keyof typeof MENU_ICONS;

export const getMenuIcon = (name: MenuIconName) =>
    `data:image/svg+xml;base64,${btoa(MENU_ICONS[name])}`;
