import type { ScanRect } from '@/components/ScanOverlay.vue';

// <img> 在页面上真正画出来的区域: object-fit 会让图片只占元素盒子的一部分,
// 标出码的位置必须落在实际绘制的区域里, 否则框会盖到留白或相邻内容上
export function measureImageRect(img: HTMLImageElement): ScanRect | undefined {
    const box = img.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return undefined;
    const boxRect: ScanRect = { x: box.left, y: box.top, width: box.width, height: box.height };

    const { naturalWidth, naturalHeight } = img;
    // 图片还没解码出尺寸时只能按元素盒子算
    if (!naturalWidth || !naturalHeight) return boxRect;

    const fit = getComputedStyle(img).objectFit;
    if (fit !== 'contain' && fit !== 'cover' && fit !== 'none' && fit !== 'scale-down') {
        // fill 与未知取值都按拉伸铺满元素处理
        return boxRect;
    }

    const contain = Math.min(box.width / naturalWidth, box.height / naturalHeight);
    const scale = fit === 'cover'
        ? Math.max(box.width / naturalWidth, box.height / naturalHeight)
        : fit === 'none'
            ? 1
            : fit === 'scale-down'
                ? Math.min(1, contain)
                : contain;
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    const drawn: ScanRect = {
        x: box.left + (box.width - width) / 2,
        y: box.top + (box.height - height) / 2,
        width,
        height,
    };
    // cover / none 会溢出元素盒子, 只保留看得见的部分
    if (fit === 'cover' || fit === 'none') return intersectRect(drawn, boxRect) ?? boxRect;
    return drawn;
}

// 两个矩形的交集, 没有重叠时返回 undefined
export function intersectRect(a: ScanRect, b: ScanRect): ScanRect | undefined {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    if (right - x < 1 || bottom - y < 1) return undefined;
    return { x, y, width: right - x, height: bottom - y };
}
