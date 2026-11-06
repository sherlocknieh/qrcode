import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ScanRect } from '@/components/ScanAnimation.vue';
import type { DecodeResult } from '@/services/qrScanner';
import { intersectRect } from '@/services/imageRect';
import { isNoticeShowing } from '@/services/popupNotice';

// 点选锚点: 说明解码用的图像画在屏幕的哪块矩形上。
// 各入口(扫描屏幕的结果截图/网页图片/扫描面板)只需要给出这个矩形,
// 绿框定位、点选切结果、空白收起都由 useCodePicker 统一处理。
export type PickAnchor = {
    // 图像在视口中的显示矩形 (CSS 像素, 锚定时)
    rect: ScanRect;
    // 解码所用图像的像素尺寸
    imageSize: { width: number; height: number };
    // 锚定时的滚动位置与视口宽度, 用来跟随滚动、判断何时该收起
    scroll: { x: number; y: number };
    viewportWidth: number;
    // 页面内容会随滚动移动时为 true; 固定在浮层里的面板传 false
    followScroll: boolean;
    // 能重新测量图像实时位置时传进来, 传入后 rect 只在锚定时用一次,
    // 之后每次重算都以实测结果为准, 图片完全离开视口时返回 undefined
    measureRect?: () => ScanRect | undefined;
    // 预览是镜像显示的 (摄像头) 时横向坐标要反过来算
    mirrorX?: boolean;
    // 只允许标记落在这个范围内: 框选扫描只截取了画面的一部分
    clip?: ScanRect;
    // 网页图片扫描时对应的图片元素: 绿框据此挂进图片所在层, 只压住图片本身
    element?: Element | null;
};

type CodePickerOptions = {
    // 点中绿点后怎么出结果: 各宿主都走统一的结果通知
    notifyResults(results: DecodeResult[]): Promise<unknown> | void;
};

// 把解码坐标换算成画面上的绿框。各入口只需给出图像显示矩形、裁剪范围与滚动差量:
// 画在页面上的入口直接渲染, 画在截图浮层上的入口再按浮层缩放一次。
export function toMarkRects(
    results: DecodeResult[],
    anchor: PickAnchor,
    scroll: { x: number; y: number } = anchor.scroll,
): ScanRect[] {
    const { rect } = anchor;
    const scaleX = anchor.imageSize.width > 0 ? rect.width / anchor.imageSize.width : 1;
    const scaleY = anchor.imageSize.height > 0 ? rect.height / anchor.imageSize.height : 1;
    const shiftX = anchor.followScroll ? scroll.x - anchor.scroll.x : 0;
    const shiftY = anchor.followScroll ? scroll.y - anchor.scroll.y : 0;
    const clip = anchor.clip && {
        ...anchor.clip,
        x: anchor.clip.x - shiftX,
        y: anchor.clip.y - shiftY,
    };

    const marks: ScanRect[] = [];
    for (const result of results) {
        const bounds = result.bounds;
        if (!bounds) continue;
        const box: ScanRect = {
            // 镜像显示时左右要翻过来, 否则绿点会压到对称位置的空白上
            x: anchor.mirrorX
                ? rect.x + rect.width - (bounds.x + bounds.width) * scaleX - shiftX
                : rect.x + bounds.x * scaleX - shiftX,
            y: rect.y + bounds.y * scaleY - shiftY,
            width: bounds.width * scaleX,
            height: bounds.height * scaleY,
        };
        const clipped = clip ? intersectRect(box, clip) : box;
        // 框选时只框住了码的一部分, 交集之外没有可点的地方
        if (clipped) marks.push(clipped);
    }
    return marks;
}

// 全屏与面板共用的多码点选: 命中码后在画面上叠绿点, 点哪个就把通知切到哪个;
// 点开过的码只摘掉圆点, 绿框留着标出已经看过的是哪一个
export function useCodePicker(options: CodePickerOptions) {
    const picked = ref<(PickAnchor & { results: DecodeResult[] }) | null>(null);
    // 与 results 对齐: true 表示这个码已经点开过
    const pickedFlags = ref<boolean[]>([]);
    // 绿框跟随的图片元素: 供宿主把它渲染进图片所在层, 没有实体图片时为空
    const anchorElement = computed(() => picked.value?.element ?? null);
    // 页面滚动后框要跟着码走, 滚动位置用响应式保存下来触发重算
    const scrollPos = ref({ x: window.scrollX, y: window.scrollY });

    const marks = computed<ScanRect[]>(() => {
        // 滚动位置同时是重算的触发器: 必须无条件先读一次,
        // 否则走 measureRect 分支时 Vue 收不到依赖, 滚动后不会重新求值
        const scroll = scrollPos.value;
        const current = picked.value;
        if (!current) return [];
        // 修复固定不随页面滚动的图片(如图片查看器里的图)上绿框滚一下就漂移的问题:
        // 这类图片的屏幕位置与滚动无关, 按滚动差量平移会把框推离码所在位置,
        // 改为每次都测量图片实时位置, 图片动没动都能对准
        if (current.measureRect) {
            const rect = current.measureRect();
            return rect ? toMarkRects(current.results, { ...current, rect, followScroll: false }) : [];
        }
        return toMarkRects(current.results, current, scroll);
    });

    // 还没点开过的码数: 宿主据此判断什么时候可以收起整层标记
    const remaining = computed(() => pickedFlags.value.filter((flag) => !flag).length);

    // 结果显示在画面上: 与结果通知同时给出, 点哪个就把通知切到哪个
    function show(results: DecodeResult[], anchor: PickAnchor) {
        clear();
        const located = results.filter((result) => result.bounds);
        if (!located.length) return;
        pickedFlags.value = located.map(() => false);
        // 修复全屏扫描命中后绿框错位、滚动一下才归位的问题:
        // 滚动位置只在滚动事件里更新, 没有绿框时根本不记录, 沿用旧值会让首帧
        // 按"旧滚动位置 - 截图时的滚动位置"整体偏移, 这里同步成锚点记录的滚动位置
        scrollPos.value = { x: anchor.scroll.x, y: anchor.scroll.y };
        picked.value = { ...anchor, results: located };
    }

    function clear() {
        picked.value = null;
        pickedFlags.value = [];
    }

    // 点中绿点: 通知切到这个码的结果, 只摘掉它的圆点; 绿框留着标出已经看过,
    // 其余码继续可点
    function pick(index: number) {
        const current = picked.value;
        const result = current?.results[index];
        if (!current || !result || pickedFlags.value[index]) return;
        pickedFlags.value = pickedFlags.value.map((flag, i) => (i === index ? true : flag));
        void options.notifyResults([result]);
    }

    // 点击空白处收起绿点。但通知还开着时, 这一下往往是去关通知的,
    // 若此时收起, 用户就没法接着点码了, 所以留到下一次点击再收
    async function dismiss() {
        if (await isNoticeShowing()) return;
        clear();
    }

    // 点在绿点以外的任何地方都算"点空白"; 用 document 捕获阶段监听,
    // 这样页面与面板里的按钮照常可用, 不必用一层覆盖全屏的透明层抢点击
    function onDocumentClick(event: MouseEvent) {
        if (!picked.value) return;
        const target = event.target;
        // 绿点与整个绿框都算"点中了码"; 通知本身也是独立浮层 (如"显示全部"),
        // 点它不算点空白, 不能因此撤掉还能点的绿框
        if (target instanceof Element && target.closest('.qr-marks-dot, .qr-marks-item, .qr-notify-root')) return;
        void dismiss();
    }

    function onScroll() {
        const current = picked.value;
        if (!current) return;
        // 带测量函数的锚点也要重算: 图片可能固定不动, 但位置要以实测为准,
        // 内部容器滚动时 window.scrollY 不变, 靠新对象赋值照常触发
        if (!current.followScroll && !current.measureRect) return;
        scrollPos.value = { x: window.scrollX, y: window.scrollY };
    }

    // 宽度变了页面会重新排版, 码的位置跟着变: 能重测位置的锚点(网页图片)直接重算即可,
    // 其余锚点的位置是按旧排版算死的, 框没法再对准, 直接收起。
    // 只改高度时横向排版没动, 框的位置仍然有效, 一律不必关闭
    function onResize() {
        const current = picked.value;
        if (!current) return;
        if (current.measureRect) {
            scrollPos.value = { x: window.scrollX, y: window.scrollY };
            return;
        }
        if (window.innerWidth === current.viewportWidth) return;
        clear();
    }

    onMounted(() => {
        // scroll 不冒泡, 用捕获阶段接收页面内部滚动
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
        window.addEventListener('resize', onResize);
        document.addEventListener('click', onDocumentClick, true);
    });

    onBeforeUnmount(() => {
        window.removeEventListener('scroll', onScroll, { capture: true });
        window.removeEventListener('resize', onResize);
        document.removeEventListener('click', onDocumentClick, true);
    });

    return { marks, anchorElement, pickedFlags, remaining, show, clear, pick };
}
