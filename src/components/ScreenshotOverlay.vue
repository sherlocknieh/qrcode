<!-- 截图容器 -->

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScanMarks from '@/components/ScanMarks.vue';
import type { ScanRect } from '@/components/ScanOverlay.vue';
import { setScreenshotIntroEnabled } from '@/services/screenshotSettings';

const props = withDefaults(
    defineProps<{
        src: string;
        // 是否播放"全屏闪光 -> 收缩到居中窗口"的入场动画
        intro?: boolean;
    }>(),
    { intro: false },
);

const emit = defineEmits<{
    // rect 是选区在浮层显示区域中的位置, viewport 是截图时的视口尺寸
    (event: 'confirm', payload: { dataUrl: string; rect: Rect; viewport: { width: number; height: number } }): void;
    // 点中结果绿点: 宿主把通知切到该码
    (event: 'pick', index: number): void;
    // 单击 (没拖出选区) 视为退出: 宿主确认没有通知在显示后收起这层
    (event: 'blank'): void;
    (event: 'cancel'): void;
    (event: 'error'): void;
}>();

const t = (key: Parameters<typeof browser.i18n.getMessage>[0], fallback: string) =>
    browser.i18n.getMessage(key) || fallback;

const FLOATING_MAX_WIDTH = 1600;
const FLOATING_MAX_HEIGHT = 1100;
const FLOATING_VIEWPORT_WIDTH_RATIO = 0.95;
const FLOATING_VIEWPORT_HEIGHT_RATIO = 0.9;
const MIN_SELECTION = 8;
const HANDLE_SIZE = 6;
const HANDLE_HIT_SIZE = 9;
// 确认按钮与选区、画面边缘之间的间距
const TOOLBAR_GAP = 8;
const TOOLBAR_MARGIN = 8;
// 拖框时的选框与手柄用蓝色, 与扫描结果的绿框区分开: 蓝框是用户正在画的范围, 绿框是已经命中的码
const SELECTION_COLOR = '#2CABFF';
// 与整屏扫描扫描动画的遮罩保持一致
const MASK_COLOR = 'rgba(8, 12, 20, 0.22)';

// 入场: 全屏 + 四周闪光, 再收缩到居中窗口
const INTRO_FLASH_DURATION = 380;
const INTRO_SHRINK_DURATION = 420;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Phase = 'cover' | 'select';

type Rect = { x: number; y: number; width: number; height: number };
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type DragState =
    | { mode: 'create'; startX: number; startY: number }
    | { mode: 'move'; startX: number; startY: number; origin: Rect }
    | { mode: 'resize'; handle: Handle; startX: number; startY: number; origin: Rect };

const HANDLE_CURSORS: Record<Handle, string> = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
};

const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));

function getHandlePoints(rect: Rect): Array<[Handle, number, number]> {
    const left = rect.x;
    const right = rect.x + rect.width;
    const top = rect.y;
    const bottom = rect.y + rect.height;
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return [
        ['nw', left, top],
        ['n', centerX, top],
        ['ne', right, top],
        ['e', right, centerY],
        ['se', right, bottom],
        ['s', centerX, bottom],
        ['sw', left, bottom],
        ['w', left, centerY],
    ];
}

const rootRef = ref<HTMLDivElement>();
const canvasRef = ref<HTMLCanvasElement>();
const toolbarRef = ref<HTMLDivElement>();

const viewport = ref({
    width: Math.max(window.innerWidth, 1),
    height: Math.max(window.innerHeight, 1),
});
const imageSize = ref({ width: 0, height: 0 });
const loaded = ref(false);
const selection = ref<Rect | null>(null);
const toolbarPosition = ref({ left: 0, top: 0 });
const cursor = ref('crosshair');

// 每次截图默认铺满视口; 窗口尺寸变化后自动切为居中大浮窗
const floatingMode = ref(false);
// 只在进入浮窗时短暂开启尺寸过渡: 拖拽框选时不能带过渡
const allowLayoutTransition = ref(false);
let layoutTransitionTimer: number | undefined;

const beginLayoutTransition = (duration = 340) => {
    allowLayoutTransition.value = true;
    if (layoutTransitionTimer !== undefined) window.clearTimeout(layoutTransitionTimer);
    layoutTransitionTimer = window.setTimeout(() => {
        layoutTransitionTimer = undefined;
        allowLayoutTransition.value = false;
    }, duration);
};

// 冻结: 扫描结果的绿框叠在截图浮层上; 截图仍可继续框选, 拖一下就开始扫下一块
const frozen = ref(false);

// 扫描结果: 按截图时的视口坐标给出, 由本层换算到浮层当前显示区域
const resultMarks = ref<ScanRect[]>([]);
// 与绿框对齐: 标出已经点开过的码, 这些只留绿框、不再显示圆点
const pickedMarks = ref<boolean[]>([]);
// 在结果画面上重新框选时暂存上一轮绿框与选区, 用户放弃这次框选就恢复
let archivedMarks: ScanRect[] | null = null;
let archivedPicked: boolean[] | null = null;
let archivedSelection: Rect | null = null;
// 冻结画面上的按下既可能是单击 (退出) 也可能是要拖框: 先只记快照,
// 真拖出选区才撤下绿框; 按下就清空的话, 松手前会渲染出一帧没有绿框的画面 (框会闪一下)
let pendingArchive: { marks: ScanRect[]; picked: boolean[]; selection: Rect | null } | null = null;
const sourceViewport = ref<{ width: number; height: number } | null>(null);
// 仅在浮窗模式且未要求减少动态效果时才播放入场动画
const canAnimateIntro = computed(() => floatingMode.value && !prefersReducedMotion);
const phase = ref<Phase>(canAnimateIntro.value ? 'cover' : 'select');
const flashing = ref(false);
const settling = ref(false);

const dpr = window.devicePixelRatio || 1;
let image: HTMLImageElement | undefined;
let drag: DragState | null = null;
let resizeFrame: number | undefined;

// 关闭浮窗模式时截图铺满整个视口; 开启时收缩到按截图比例计算的居中窗口
const layout = computed(() => {
    if (!floatingMode.value || phase.value === 'cover') {
        return {
            width: Math.max(1, viewport.value.width),
            height: Math.max(1, viewport.value.height),
            left: 0,
            top: 0,
        };
    }

    const aspect = imageSize.value.width > 0 && imageSize.value.height > 0
        ? imageSize.value.width / imageSize.value.height
        : 1;
    const maxWidth = Math.min(
        FLOATING_MAX_WIDTH,
        Math.floor(viewport.value.width * FLOATING_VIEWPORT_WIDTH_RATIO),
    );
    const maxHeight = Math.min(
        FLOATING_MAX_HEIGHT,
        Math.floor(viewport.value.height * FLOATING_VIEWPORT_HEIGHT_RATIO),
    );

    let width = maxWidth;
    let height = Math.round(width / aspect);
    if (height > maxHeight) {
        height = maxHeight;
        width = Math.round(height * aspect);
    }

    width = Math.max(1, width);
    height = Math.max(1, height);

    return {
        width,
        height,
        left: Math.floor((viewport.value.width - width) / 2),
        top: Math.floor((viewport.value.height - height) / 2),
    };
});

const pixelWidth = computed(() => Math.max(1, Math.round(layout.value.width * dpr)));
const pixelHeight = computed(() => Math.max(1, Math.round(layout.value.height * dpr)));

// 动画期间浮窗从全屏收缩到居中窗口
const rootStyle = computed(() => {
    const width = phase.value === 'cover' ? viewport.value.width : layout.value.width;
    const height = phase.value === 'cover' ? viewport.value.height : layout.value.height;
    return {
        left: phase.value === 'cover' ? '0px' : `${layout.value.left - 1}px`,
        top: phase.value === 'cover' ? '0px' : `${layout.value.top - 1}px`,
        width: `${width}px`,
        height: `${height}px`,
        '--qr-shot-radius': phase.value === 'cover' ? '0px' : '12px',
    };
});

const canvasStyle = computed(() => ({
    width: `${phase.value === 'cover' ? viewport.value.width : layout.value.width}px`,
    height: `${phase.value === 'cover' ? viewport.value.height : layout.value.height}px`,
}));

// 入场动画期间或正在拖动时都算忙, 不显示工具栏
const busy = computed(
    () => canAnimateIntro.value && (phase.value === 'cover' || settling.value),
);

const hasSelection = computed(() => {
    const rect = selection.value;
    return rect !== null && rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION;
});

const showToolbar = computed(() => loaded.value && !busy.value && !frozen.value && hasSelection.value);


const marksLayerStyle = computed(() => {
    const source = sourceViewport.value;
    const width = source?.width ?? layout.value.width;
    const height = source?.height ?? layout.value.height;
    return {
        width: `${width}px`,
        height: `${height}px`,
        transform: `scale(${width > 0 ? layout.value.width / width : 1})`,
    };
});

const toolbarStyle = computed(() => ({
    left: `${toolbarPosition.value.left}px`,
    top: `${toolbarPosition.value.top}px`,
}));

const sourceScaleX = computed(() =>
    layout.value.width > 0 ? imageSize.value.width / layout.value.width : 1,
);
const sourceScaleY = computed(() =>
    layout.value.height > 0 ? imageSize.value.height / layout.value.height : 1,
);

const getPointerPosition = (event: PointerEvent) => {
    const canvas = canvasRef.value;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
        x: clamp(event.clientX - rect.left, 0, layout.value.width),
        y: clamp(event.clientY - rect.top, 0, layout.value.height),
    };
};

const hitHandle = (x: number, y: number): Handle | undefined => {
    const rect = selection.value;
    if (!rect) return undefined;
    return getHandlePoints(rect).find(
        ([, pointX, pointY]) =>
            Math.abs(x - pointX) <= HANDLE_HIT_SIZE && Math.abs(y - pointY) <= HANDLE_HIT_SIZE,
    )?.[0];
};

const isInsideSelection = (x: number, y: number) => {
    const rect = selection.value;
    return (
        rect !== null &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
    );
};

const draw = () => {
    const canvas = canvasRef.value;
    if (!canvas || !image || !loaded.value) return;
    const context = canvas.getContext('2d');
    if (!context) return;

    const width = layout.value.width;
    const height = layout.value.height;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    // 画面铺满视口, 再叠一层与整屏扫描一致的淡遮罩; 选中的区域或结果绿框内部挖空,
    // 让码本身保持清晰, 冻结后也能一眼看出标记的是哪几块
    const rect = selection.value;
    context.beginPath();
    context.rect(0, 0, width, height);
    if (frozen.value && resultMarks.value.length) {
        // 结果绿框按浮层初始显示区域记录, 窗口尺寸变化后要换算回当前画布坐标
        const source = sourceViewport.value;
        const scale = source && source.width > 0 ? layout.value.width / source.width : 1;
        for (const mark of resultMarks.value) {
            context.rect(mark.x * scale, mark.y * scale, mark.width * scale, mark.height * scale);
        }
    } else if (rect) {
        context.rect(rect.x, rect.y, rect.width, rect.height);
    }
    context.fillStyle = MASK_COLOR;
    context.fill('evenodd');

    // 冻结后选区只负责在遮罩上挖空: 蓝色选框与手柄都退场, 让结果绿框成为唯一焦点;
    // 识别结束时选区本身也会被清空, 高亮块随之一起消失
    if (frozen.value) return;

    if (rect) {
        context.strokeStyle = SELECTION_COLOR;
        context.lineWidth = 1;
        context.strokeRect(
            rect.x + 0.5,
            rect.y + 0.5,
            Math.max(0, rect.width - 1),
            Math.max(0, rect.height - 1),
        );

        context.fillStyle = SELECTION_COLOR;
        context.strokeStyle = '#fff';
        for (const [, pointX, pointY] of getHandlePoints(rect)) {
            context.beginPath();
            context.rect(
                pointX - HANDLE_SIZE / 2,
                pointY - HANDLE_SIZE / 2,
                HANDLE_SIZE,
                HANDLE_SIZE,
            );
            context.fill();
            context.stroke();
        }
    }
};

const updateToolbarPosition = () => {
    const toolbar = toolbarRef.value;
    const rect = selection.value;
    if (!toolbar || !rect || !hasSelection.value) return;

    const halfWidth = toolbar.offsetWidth / 2;
    const halfHeight = toolbar.offsetHeight / 2;
    const bottom = rect.y + rect.height;

    // 工具条位于选框下方居中, 并限制在画面内
    const left = rect.x + rect.width / 2;
    const top = bottom + TOOLBAR_GAP + halfHeight;

    toolbarPosition.value = {
        left: clamp(
            left,
            halfWidth + TOOLBAR_MARGIN,
            Math.max(halfWidth + TOOLBAR_MARGIN, layout.value.width - halfWidth - TOOLBAR_MARGIN),
        ),
        top: clamp(
            top,
            halfHeight + TOOLBAR_MARGIN,
            Math.max(halfHeight + TOOLBAR_MARGIN, layout.value.height - halfHeight - TOOLBAR_MARGIN),
        ),
    };
};

const updateCursor = (x?: number, y?: number) => {
    if (!selection.value || x === undefined || y === undefined) {
        cursor.value = 'crosshair';
        return;
    }
    const handle = hitHandle(x, y);
    if (handle) {
        cursor.value = HANDLE_CURSORS[handle];
        return;
    }
    cursor.value = isInsideSelection(x, y) ? 'move' : 'crosshair';
};

const resizeSelection = (origin: Rect, handle: Handle, dx: number, dy: number): Rect => {
    let left = origin.x;
    let top = origin.y;
    let right = origin.x + origin.width;
    let bottom = origin.y + origin.height;

    if (handle.includes('w')) left = Math.min(right - MIN_SELECTION, left + dx);
    if (handle.includes('e')) right = Math.max(left + MIN_SELECTION, right + dx);
    if (handle.includes('n')) top = Math.min(bottom - MIN_SELECTION, top + dy);
    if (handle.includes('s')) bottom = Math.max(top + MIN_SELECTION, bottom + dy);

    left = clamp(left, 0, layout.value.width);
    right = clamp(right, 0, layout.value.width);
    top = clamp(top, 0, layout.value.height);
    bottom = clamp(bottom, 0, layout.value.height);

    return { x: left, y: top, width: right - left, height: bottom - top };
};

const cropSelection = (rect: Rect) => {
    if (!image) return '';
    const scaleX = sourceScaleX.value;
    const scaleY = sourceScaleY.value;
    const sourceX = clamp(Math.round(rect.x * scaleX), 0, imageSize.value.width);
    const sourceY = clamp(Math.round(rect.y * scaleY), 0, imageSize.value.height);
    const sourceWidth = Math.max(
        1,
        Math.min(Math.round(rect.width * scaleX), imageSize.value.width - sourceX),
    );
    const sourceHeight = Math.max(
        1,
        Math.min(Math.round(rect.height * scaleY), imageSize.value.height - sourceY),
    );

    const output = document.createElement('canvas');
    output.width = sourceWidth;
    output.height = sourceHeight;
    const context = output.getContext('2d');
    if (!context) return '';
    context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight,
    );
    return output.toDataURL('image/png');
};

let introTimer: number | undefined;
let introSettleTimer: number | undefined;

const clearTimers = () => {
    if (introTimer !== undefined) window.clearTimeout(introTimer);
    if (introSettleTimer !== undefined) window.clearTimeout(introSettleTimer);
    introTimer = undefined;
    introSettleTimer = undefined;
};

// 入场: 整屏截图覆盖视口并闪一下, 再收缩到居中窗口
function startIntro() {
    if (!canAnimateIntro.value) {
        phase.value = 'select';
        return;
    }
    phase.value = 'cover';
    flashing.value = true;
    introTimer = window.setTimeout(() => {
        introTimer = undefined;
        flashing.value = false;
        settling.value = true;
        phase.value = 'select';
        introSettleTimer = window.setTimeout(() => {
            introSettleTimer = undefined;
            settling.value = false;
        }, INTRO_SHRINK_DURATION);
    }, INTRO_FLASH_DURATION);
}

// 真的开始拖框时才撤下上一轮绿框: 快照先放着, 拖出选区再落到 archived*
function archivePending() {
    if (!pendingArchive) return;
    archivedMarks = pendingArchive.marks;
    archivedPicked = pendingArchive.picked;
    archivedSelection = pendingArchive.selection;
    pendingArchive = null;
    resultMarks.value = [];
    pickedMarks.value = [];
    frozen.value = false;
}

// 放弃这次框选: 把上一轮绿框与选区原样放回来
function restoreArchived(): boolean {
    if (archivedMarks === null) return false;
    resultMarks.value = archivedMarks;
    pickedMarks.value = archivedPicked ?? archivedMarks.map(() => false);
    selection.value = archivedSelection;
    archivedMarks = null;
    archivedPicked = null;
    archivedSelection = null;
    frozen.value = true;
    return true;
}

// 取消: 在结果画面上重新框选时只撤回这次框选, 其余情况收起浮层
const cancel = () => {
    if (busy.value) return;
    pendingArchive = null;
    if (restoreArchived()) return;
    emit('cancel');
};

const confirm = () => {
    if (busy.value || frozen.value || !selection.value || !hasSelection.value) return;
    const selectionRect = selection.value;
    const result = cropSelection(selectionRect);
    if (!result) return;
    const viewportWidth = viewport.value.width;
    const viewportHeight = viewport.value.height;
    // 确认后冻结框选: 扫描期间截图继续留在浮层上, 后续的绿框也标在这张截图上
    frozen.value = true;
    archivedMarks = null;
    archivedPicked = null;
    archivedSelection = null;
    // 修复改过窗口大小后再框选、绿框略微错位的问题:
    // 截图是改尺寸之前拍的, 浮窗按截图比例收缩, 宽高比和改后的视口不同;
    // 先把选区换算到视口坐标、绿框层再按宽度统一缩放回来, 纵向就会差一截。
    // 改为都按浮层显示区域记录与缩放, 两个方向始终等比例
    sourceViewport.value = { width: layout.value.width, height: layout.value.height };
    emit('confirm', {
        dataUrl: result,
        rect: { ...selectionRect },
        viewport: { width: viewportWidth, height: viewportHeight },
    });
};

// 浮层本身不可滚动, 不阻止的话滚轮会沿滚动链滚到底层页面
const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
};

// 结果画面上继续框选: 拖出选区后照常确认、扫描新区域;
// 没拖出选区就松开的行为在 pointerup 里处理
const handlePointerDown = (event: PointerEvent) => {
    if (busy.value || event.button !== 0) return;
    if (frozen.value) {
        pendingArchive = {
            marks: resultMarks.value,
            picked: pickedMarks.value,
            selection: selection.value,
        };
    }
    event.preventDefault();
    // 捕获指针, 保证在窗口外松开鼠标时也能收到 pointerup
    canvasRef.value?.setPointerCapture(event.pointerId);

    const { x, y } = getPointerPosition(event);
    const handle = hitHandle(x, y);
    if (selection.value && handle) {
        drag = { mode: 'resize', handle, startX: x, startY: y, origin: { ...selection.value } };
        return;
    }
    if (selection.value && isInsideSelection(x, y)) {
        drag = { mode: 'move', startX: x, startY: y, origin: { ...selection.value } };
        return;
    }
    selection.value = { x, y, width: 0, height: 0 };
    drag = { mode: 'create', startX: x, startY: y };
};

const handlePointerMove = (event: PointerEvent) => {
    if (busy.value) return;
    const { x, y } = getPointerPosition(event);
    if (!drag) {
        updateCursor(x, y);
        return;
    }
    event.preventDefault();
    // 按下后真的拖开了才撤下绿框, 单击只清光标不动画面
    if (
        pendingArchive
        && (Math.abs(x - drag.startX) >= MIN_SELECTION || Math.abs(y - drag.startY) >= MIN_SELECTION)
    ) {
        archivePending();
    }

    if (drag.mode === 'create') {
        selection.value = {
            x: Math.min(drag.startX, x),
            y: Math.min(drag.startY, y),
            width: Math.abs(x - drag.startX),
            height: Math.abs(y - drag.startY),
        };
    } else if (drag.mode === 'move') {
        const left = clamp(
            drag.origin.x + x - drag.startX,
            0,
            layout.value.width - drag.origin.width,
        );
        const top = clamp(
            drag.origin.y + y - drag.startY,
            0,
            layout.value.height - drag.origin.height,
        );
        selection.value = {
            x: left,
            y: top,
            width: drag.origin.width,
            height: drag.origin.height,
        };
        cursor.value = 'move';
    } else {
        selection.value = resizeSelection(drag.origin, drag.handle, x - drag.startX, y - drag.startY);
    }
};

const handlePointerUp = (event: PointerEvent) => {
    const canvas = canvasRef.value;
    if (canvas?.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
    }
    if (!drag) return;
    const mode = drag.mode;
    drag = null;
    // 单击时快照直接丢掉: 画面本来就没被动过, 不必清空再恢复
    pendingArchive = null;
    if (selection.value && !hasSelection.value) {
        selection.value = null;
        // 单击 (没拖出选区) 就是退出: 交给宿主收摊, 通知还开着时宿主会忽略, 画面保持原样
        if (mode === 'create') {
            restoreArchived();
            emit('blank');
        }
    }
};

const handleOutsidePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!loaded.value || busy.value) return;
    if (target instanceof Node && rootRef.value?.contains(target)) return;
    // 页面内兜底通知叠在截图层之上 (通知宿主挂在 body 上, 不在截图容器内):
    // 点它是去关通知, 不算点外部, 否则关通知的同时会把截图一起收掉, 没法接着框选
    if (target instanceof Element && target.closest('.qr-notify-root')) return;
    cancel();
};

const handleKeyDown = (event: KeyboardEvent) => {
    if (!loaded.value || busy.value) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        confirm();
        return;
    }
};

const handleWindowResize = () => {
    if (loaded.value && !floatingMode.value && !busy.value) {
        // 窗口一变就从铺满收成居中大浮窗, 尺寸与位置带过渡, 不做硬切
        beginLayoutTransition(420);
        window.requestAnimationFrame(() => {
            floatingMode.value = true;
            void setScreenshotIntroEnabled(true).catch(() => {});
        });
    }
    if (resizeFrame !== undefined) return;
    resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = undefined;
        viewport.value = {
            width: Math.max(window.innerWidth, 1),
            height: Math.max(window.innerHeight, 1),
        };
    });
};

watch(
    layout,
    (next, previous) => {
        const rect = selection.value;
        if (!rect || !previous.width || !previous.height) return;
        const ratioX = next.width / previous.width;
        const ratioY = next.height / previous.height;
        selection.value = {
            x: rect.x * ratioX,
            y: rect.y * ratioY,
            width: rect.width * ratioX,
            height: rect.height * ratioY,
        };
    },
);

watch(
    [layout, selection, loaded, frozen, resultMarks],
    () => {
        draw();
        nextTick(updateToolbarPosition);
    },
    { flush: 'post' },
);

onMounted(() => {
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('resize', handleWindowResize);
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handleOutsidePointerDown, true);

    const element = new Image();
    element.onload = () => {
        image = element;
        imageSize.value = {
            width: element.naturalWidth || element.width,
            height: element.naturalHeight || element.height,
        };
        loaded.value = true;
        startIntro();
    };
    element.onerror = () => emit('error');
    element.src = props.src;
});

onBeforeUnmount(() => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('resize', handleWindowResize);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    clearTimers();
    if (resizeFrame !== undefined) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = undefined;
    }
    if (layoutTransitionTimer !== undefined) window.clearTimeout(layoutTransitionTimer);
});

defineExpose({
    // 扫描命中: 在冻结的截图上标出码的绿框, 之后仍可继续框选其他区域
    showResults(marks: ScanRect[]) {
        frozen.value = true;
        archivedMarks = null;
        archivedSelection = null;
        pendingArchive = null;
        // 识别完成即收起这次选区: 遮罩恢复整片压暗, 只留结果绿框;
        // 否则高亮块会一直挂在画面上, 看着像还在扫这一块
        selection.value = null;
        // 整屏扫描没有经过框选确认: 在这里补记绿框层对应的显示区域,
        // 之后切成浮窗或改窗口大小时才能整体缩放对齐
        sourceViewport.value = { width: layout.value.width, height: layout.value.height };
        resultMarks.value = marks;
        pickedMarks.value = marks.map(() => false);
        archivedPicked = null;
    },
    // 没扫到码: 清掉绿框, 但留住截图与这次的挖空范围,
    // 用户能看清刚才扫的是哪一块, 直接拖下一块重扫
    clearResults(rect?: ScanRect) {
        frozen.value = true;
        archivedMarks = null;
        archivedSelection = null;
        pendingArchive = null;
        if (rect) selection.value = rect;
        resultMarks.value = [];
        pickedMarks.value = [];
    },
    // 点掉一个绿点只摘掉它的圆点: 绿框留着标出这个码已经看过,
    // 位置按数组下标记录, 不重新换算坐标
    markPicked(index: number) {
        if (index < 0 || index >= pickedMarks.value.length) return;
        pickedMarks.value = pickedMarks.value.map((flag, markIndex) => (
            markIndex === index ? true : flag
        ));
    },
    // 浮层显示区域坐标 → 视口坐标: 扫描动画挂在页面上, 浮窗模式下要加上窗口偏移
    toViewportRect(rect: ScanRect): ScanRect {
        const { left, top } = layout.value;
        return { x: rect.x + left, y: rect.y + top, width: rect.width, height: rect.height };
    },
});
</script>

<template>
    <div
        v-if="loaded"
        ref="rootRef"
        class="qr-shot"
        :class="{
            'qr-shot--floating': floatingMode,
            'qr-shot--animating': busy,
            'qr-shot--frozen': frozen,
            'qr-shot--transitioning': allowLayoutTransition,
        }"
        :style="[rootStyle, { cursor: busy ? 'default' : cursor }]"
        @wheel="handleWheel">
        <!-- 截图框选画布 -->
        <canvas
            ref="canvasRef"
            class="qr-shot-canvas"
            :width="pixelWidth"
            :height="pixelHeight"
            :style="canvasStyle"
            @pointerdown="handlePointerDown" />
        <!-- 扫描结果直接标在冻结的截图上: 绿框按截图时的视口坐标换算到浮层当前显示区域 -->
        <div
            v-if="frozen && resultMarks.length"
            class="qr-shot-marks"
            :style="marksLayerStyle">
            <ScanMarks :rects="resultMarks" :picked="pickedMarks" @pick="emit('pick', $event)" />
        </div>
        <!-- 截图闪光效果容器 -->
        <div v-if="flashing" class="qr-shot-flash" aria-hidden="true">
            <span class="qr-shot-flash-edge edge-top" />
            <span class="qr-shot-flash-edge edge-right" />
            <span class="qr-shot-flash-edge edge-bottom" />
            <span class="qr-shot-flash-edge edge-left" />
        </div>
        <!-- 截图工具栏: 取消 / 确认 -->
        <div v-if="showToolbar" ref="toolbarRef" class="qr-shot-toolbar" :style="toolbarStyle">
            <!-- 确认按钮 -->
            <button
                class="qr-shot-btn qr-shot-btn--confirm"
                type="button"
                :aria-label="t('confirm', '确认')"
                :title="t('confirm', '确认')"
                @click="confirm"
            >{{ t('confirm', '确认') }}</button>
        </div>
    </div>
</template>

<style scoped>
.qr-shot {
    position: fixed;
    z-index: 2147483647;
    overflow: visible;
    user-select: none;
    touch-action: none;
}

.qr-shot-canvas {
    display: block;
    touch-action: none;
}

/* 冻结后让出一层: 页面内的兜底通知与扫描动画要能盖在截图之上, 否则会被挡住 */
.qr-shot--frozen {
    z-index: 2147483646;
}

/* 结果绿框层: 按截图时的视口尺寸铺开, 再缩放对齐到浮层当前显示区域;
   空白处不拦事件, 指针要能落回画布继续框选 (只有绿点自己接管点击) */
.qr-shot-marks {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    pointer-events: none;
}

/* 页面全局样式会泄漏进注入的 UI（如 example.com 的 svg 外边距规则），把图标拉回原位 */
.qr-shot svg {
    margin: 0;
    opacity: 1;
}

/* 浮窗模式: 收缩后的窗口外框 */
.qr-shot--floating {
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: var(--qr-shot-radius, 12px);
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.18),
        0 20px 45px rgba(0, 0, 0, 0.42);
}

.qr-shot--floating .qr-shot-canvas {
    border-radius: inherit;
}

/* 入场动画期间才启用收缩过渡, 日常切换显示模式保持即时 */
.qr-shot--animating {
    transform-origin: top left;
    will-change: left, top, width, height;
    transition:
        left 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        top 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        width 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        height 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        border-radius 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

.qr-shot--animating .qr-shot-canvas {
    border-radius: inherit;
    transition:
        width 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        height 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* 入场时四周闪光, 模拟快门 */
.qr-shot-flash {
    position: absolute;
    inset: 0;
    pointer-events: none;
    animation: qr-shot-flash-fade 380ms ease-out both;
}

.qr-shot-flash::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(
        ellipse at center,
        rgba(255, 255, 255, 0) 45%,
        rgba(255, 255, 255, 0.35) 100%
    );
}

.qr-shot-flash-edge {
    position: absolute;
    display: block;
    background: linear-gradient(90deg, transparent, #fff, transparent);
    filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.9));
    opacity: 0;
    animation: qr-shot-flash-sweep 380ms ease-out both;
}

.edge-top,
.edge-bottom {
    left: 0;
    right: 0;
    height: 2px;
    transform: scaleX(0.4);
}

.edge-left,
.edge-right {
    top: 0;
    bottom: 0;
    width: 2px;
    background: linear-gradient(180deg, transparent, #fff, transparent);
    transform: scaleY(0.4);
}

.edge-top {
    top: 0;
}

.edge-right {
    right: 0;
    animation-delay: 60ms;
}

.edge-bottom {
    bottom: 0;
    animation-delay: 40ms;
}

.edge-left {
    left: 0;
    animation-delay: 20ms;
}

@keyframes qr-shot-flash-sweep {
    0% {
        opacity: 0;
        transform: scale(0.4);
    }
    35% {
        opacity: 1;
        transform: scale(1);
    }
    100% {
        opacity: 0;
        transform: scale(1);
    }
}

@keyframes qr-shot-flash-fade {
    0% {
        opacity: 0;
    }
    15% {
        opacity: 1;
    }
    100% {
        opacity: 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .qr-shot--animating,
    .qr-shot--animating .qr-shot-canvas {
        transition: none;
    }

    .qr-shot-flash {
        display: none;
    }
}

.qr-shot-toolbar {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    color: #fff;
    font: 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
    white-space: nowrap;
    transform: translate(-50%, -50%);
}

.qr-shot-btn {
    padding: 4px 10px;
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    transition: background-color 120ms ease;
}

.qr-shot-btn:hover {
    background: rgba(255, 255, 255, 0.16);
}

.qr-shot-btn--confirm {
    min-width: 44px;
    height: 26px;
    padding: 0 10px;
    border: none;
    border-radius: 5px;
    color: #fff;
    font-size: 12px;
    line-height: 26px;
}

.qr-shot-btn--confirm {
    background: #0a7dd1;
}

.qr-shot-btn--confirm:hover {
    background: #1b93e8;
}



/* 进入浮窗时的过渡: 只在这段时间生效, 拖拽框选不受影响 */
.qr-shot--transitioning {
    transition:
        left 0.34s ease,
        top 0.34s ease,
        width 0.34s ease,
        height 0.34s ease;
}

.qr-shot--transitioning .qr-shot-canvas {
    transition:
        width 0.34s ease,
        height 0.34s ease;
}

.qr-shot--transitioning .qr-shot-marks {
    transition: transform 0.34s ease;
}

</style>
