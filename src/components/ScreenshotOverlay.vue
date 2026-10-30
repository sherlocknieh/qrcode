<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(
    defineProps<{
        src: string;
        // 是否播放"全屏闪光 -> 收缩到居中窗口"的入场动画
        intro?: boolean;
    }>(),
    { intro: false },
);

const emit = defineEmits<{
    (event: 'confirm', dataUrl: string): void;
    (event: 'cancel'): void;
    (event: 'error'): void;
}>();

const t = (key: Parameters<typeof browser.i18n.getMessage>[0], fallback: string) =>
    browser.i18n.getMessage(key) || fallback;

const FLOATING_MAX_WIDTH = 1200;
const FLOATING_MAX_HEIGHT = 800;
const FLOATING_VIEWPORT_WIDTH_RATIO = 0.9;
const FLOATING_VIEWPORT_HEIGHT_RATIO = 0.8;
const MIN_SELECTION = 8;
const HANDLE_SIZE = 6;
const HANDLE_HIT_SIZE = 9;
const ACCENT_COLOR = '#2CABFF';
// 与整屏识别扫描动画的遮罩保持一致
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
const status = ref<{ text: string; kind: 'success' | 'error' } | null>(null);

// 开启且在未减少动态效果时才播放入场动画
const introActive = computed(() => props.intro && !prefersReducedMotion);
const phase = ref<Phase>(introActive.value ? 'cover' : 'select');
const flashing = ref(false);
const settling = ref(false);

const dpr = window.devicePixelRatio || 1;
let image: HTMLImageElement | undefined;
let drag: DragState | null = null;
let resizeFrame: number | undefined;

// 关闭入场动画时截图铺满整个视口; 开启时收缩到按截图比例计算的居中窗口
const layout = computed(() => {
    if (!introActive.value) {
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

const busy = computed(
    () => introActive.value && (phase.value === 'cover' || settling.value),
);

const hasSelection = computed(() => {
    const rect = selection.value;
    return rect !== null && rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION;
});

const showToolbar = computed(() => loaded.value && !busy.value && hasSelection.value);

// 全选/复制/保存与关闭按钮固定在右上角, 未框选时也可直接作用于整张截图
const showActions = computed(() => loaded.value && !busy.value);

// 入场动画结束后、尚未框选时提示用户拖动框选
const showHint = computed(() => loaded.value && !busy.value && !hasSelection.value);

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

const sizeLabel = computed(() => {
    const rect = selection.value;
    if (!rect) return '';
    return `${Math.round(rect.width * sourceScaleX.value)} × ${Math.round(rect.height * sourceScaleY.value)}`;
});

const showSizeLabel = computed(() => loaded.value && !busy.value && hasSelection.value);

// 尺寸标记独立于工具栏, 固定在选框左上方
const sizeLabelStyle = computed(() => {
    const rect = selection.value;
    if (!rect) return {};
    return {
        left: `${Math.round(rect.x)}px`,
        top: `${Math.round(rect.y)}px`,
    };
});

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
    // 画面铺满视口, 再叠一层与整屏识别一致的淡遮罩, 选区处挖空
    context.drawImage(image, 0, 0, width, height);

    const rect = selection.value;
    context.beginPath();
    context.rect(0, 0, width, height);
    if (rect) context.rect(rect.x, rect.y, rect.width, rect.height);
    context.fillStyle = MASK_COLOR;
    context.fill('evenodd');

    if (rect) {
        context.strokeStyle = ACCENT_COLOR;
        context.lineWidth = 1;
        context.strokeRect(
            rect.x + 0.5,
            rect.y + 0.5,
            Math.max(0, rect.width - 1),
            Math.max(0, rect.height - 1),
        );

        context.fillStyle = ACCENT_COLOR;
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

    // 识别按钮固定在选区正中央
    toolbarPosition.value = {
        left: rect.x + rect.width / 2,
        top: rect.y + rect.height / 2,
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

const dataUrlToBlob = (dataUrl: string): Blob | null => {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const mime = /data:([^;]+)/.exec(dataUrl.slice(0, comma))?.[1] ?? 'image/png';
    try {
        const binary = atob(dataUrl.slice(comma + 1));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index);
        }
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
};

const copyImage = async (dataUrl: string): Promise<boolean> => {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return false;
    try {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        return true;
    } catch {
        return false;
    }
};

const saveImage = (dataUrl: string) => {
    const pad = (value: number) => String(value).padStart(2, '0');
    const now = new Date();
    const stamp = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        '-',
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join('');

    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${t('screenshotFileName', 'Screenshot')}-${stamp}.png`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
};

let introTimer: number | undefined;
let introSettleTimer: number | undefined;
let statusTimer: number | undefined;
let closeTimer: number | undefined;

const clearTimers = () => {
    if (introTimer !== undefined) window.clearTimeout(introTimer);
    if (introSettleTimer !== undefined) window.clearTimeout(introSettleTimer);
    if (statusTimer !== undefined) window.clearTimeout(statusTimer);
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    introTimer = undefined;
    introSettleTimer = undefined;
    statusTimer = undefined;
    closeTimer = undefined;
};

// 复制/保存成功后短暂提示, 再自动关闭框选界面
const showStatus = (text: string, kind: 'success' | 'error', autoClose = false) => {
    status.value = { text, kind };
    if (statusTimer !== undefined) window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
        statusTimer = undefined;
        status.value = null;
    }, 1600);
    if (autoClose && closeTimer === undefined) {
        closeTimer = window.setTimeout(() => {
            closeTimer = undefined;
            emit('cancel');
        }, 500);
    }
};

// 入场: 整屏截图覆盖视口并闪一下, 再收缩到居中窗口
function startIntro() {
    if (!introActive.value) {
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

const cancel = () => {
    if (busy.value) return;
    emit('cancel');
};

const confirm = () => {
    if (busy.value || !selection.value || !hasSelection.value) return;
    const result = cropSelection(selection.value);
    if (!result) return;
    emit('confirm', result);
};

const selectAll = () => {
    selection.value = {
        x: 0,
        y: 0,
        width: layout.value.width,
        height: layout.value.height,
    };
};

// 有选区时输出选区, 否则输出整张截图
const getOutputDataUrl = (): string => {
    if (busy.value) return '';
    const rect =
        selection.value && hasSelection.value
            ? selection.value
            : { x: 0, y: 0, width: layout.value.width, height: layout.value.height };
    return cropSelection(rect);
};

const copySelection = async () => {
    const dataUrl = getOutputDataUrl();
    if (!dataUrl) return;
    const success = await copyImage(dataUrl);
    showStatus(
        success
            ? t('screenshotCopied', 'Copied')
            : t('screenshotCopyFailed', 'Copy failed'),
        success ? 'success' : 'error',
        success,
    );
};

const saveSelection = () => {
    const dataUrl = getOutputDataUrl();
    if (!dataUrl) return;
    try {
        saveImage(dataUrl);
        showStatus(t('screenshotSaved', 'Saved'), 'success', true);
    } catch {
        showStatus(t('screenshotSaveFailed', 'Save failed'), 'error');
    }
};

const handlePointerDown = (event: PointerEvent) => {
    if (busy.value || event.button !== 0) return;
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
    drag = null;
    if (selection.value && !hasSelection.value) {
        selection.value = null;
    }
};

const handleOutsidePointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!loaded.value || busy.value) return;
    if (target instanceof Node && rootRef.value?.contains(target)) return;
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
    // Ctrl/Cmd+C 复制截图(选区或整图), Ctrl/Cmd+S 保存截图
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
            event.preventDefault();
            event.stopPropagation();
            void copySelection();
        } else if (key === 's') {
            event.preventDefault();
            event.stopPropagation();
            saveSelection();
        }
    }
};

const handleWindowResize = () => {
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
    [layout, selection, loaded],
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
});
</script>

<template>
    <!-- 截图弹窗容器 -->
    <div
        v-if="loaded"
        ref="rootRef"
        class="qr-shot"
        :class="{ 'qr-shot--intro': introActive }"
        :style="[rootStyle, { cursor: busy ? 'default' : cursor }]"
    >   
        <!-- 截图框选画布 -->
        <canvas
            ref="canvasRef"
            class="qr-shot-canvas"
            :width="pixelWidth"
            :height="pixelHeight"
            :style="canvasStyle"
            @pointerdown="handlePointerDown"
        />
        <!-- 截图闪光效果容器 -->
        <div v-if="flashing" class="qr-shot-flash" aria-hidden="true">
            <span class="qr-shot-flash-edge edge-top" />
            <span class="qr-shot-flash-edge edge-right" />
            <span class="qr-shot-flash-edge edge-bottom" />
            <span class="qr-shot-flash-edge edge-left" />
        </div>
        <!-- 截图框选提示语 -->
        <Transition name="qr-shot-hint-fade">
            <p v-if="showHint" class="qr-shot-hint" aria-live="polite">
                {{ t('screenshotHint', 'Drag to select the area you want to scan') }}
            </p>
        </Transition>
        <!-- 尺寸标记 -->
        <span v-if="showSizeLabel" class="qr-shot-size" :style="sizeLabelStyle">
            {{ sizeLabel }}
        </span>
        <!-- 截图操作组: 全选/复制/保存/关闭固定在右上角 -->
        <div v-if="showActions" class="qr-shot-actions">
            <span
                v-if="status"
                class="qr-shot-status"
                :class="`qr-shot-status--${status.kind}`"
                aria-live="polite"
            >{{ status.text }}</span>
            <button
                class="qr-shot-btn qr-shot-btn--icon"
                type="button"
                :aria-label="t('screenshotSelectAll', 'Select all')"
                :title="t('screenshotSelectAll', 'Select all')"
                @click="selectAll"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                        d="M8 3H6.5A2.5 2.5 0 0 0 4 5.5V7m4 14H6.5A2.5 2.5 0 0 1 4 18.5V17m16-9.5V6.5A2.5 2.5 0 0 0 17.5 4H16m4 13.5v1A2.5 2.5 0 0 1 17.5 21H16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                    />
                    <rect
                        x="8"
                        y="8"
                        width="8"
                        height="8"
                        rx="1.4"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                    />
                </svg>
            </button>
            <button
                class="qr-shot-btn qr-shot-btn--icon"
                type="button"
                :aria-label="t('screenshotCopy', 'Copy')"
                :title="t('screenshotCopy', 'Copy')"
                @click="copySelection"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <rect
                        x="9"
                        y="9"
                        width="11"
                        height="11"
                        rx="2"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                    />
                    <path
                        d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                    />
                </svg>
            </button>
            <button
                class="qr-shot-btn qr-shot-btn--icon"
                type="button"
                :aria-label="t('screenshotSave', 'Save')"
                :title="t('screenshotSave', 'Save')"
                @click="saveSelection"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                        d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                    <path
                        d="M5 15.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.7"
                        stroke-linecap="round"
                    />
                </svg>
            </button>
            <button
                class="qr-shot-close"
                type="button"
                :aria-label="t('closeBtn', 'Close')"
                @click="cancel"
            >×</button>
        </div>
        <!-- 截图工具栏 -->
        <div v-if="showToolbar" ref="toolbarRef" class="qr-shot-toolbar" :style="toolbarStyle">
            <button
                class="qr-shot-btn primary qr-shot-btn--confirm"
                type="button"
                :aria-label="t('confirm', 'Scan')"
                :title="t('confirm', 'Scan')"
                @click="confirm"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                        d="m5 12.5 4.5 4.5L19 7.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    />
                </svg>
            </button>
        </div>
    </div>
</template>

<style scoped>
.qr-shot {
    position: fixed;
    z-index: 2147483647;
    overflow: visible;
    user-select: none;
}

.qr-shot-canvas {
    display: block;
    touch-action: none;
}

/* 入场动画开启时: 浮窗外框与收缩过渡 */
.qr-shot--intro {
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: var(--qr-shot-radius, 12px);
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.18),
        0 20px 45px rgba(0, 0, 0, 0.42);
    transform-origin: top left;
    will-change: left, top, width, height;
    transition:
        left 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        top 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        width 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        height 420ms cubic-bezier(0.22, 0.61, 0.36, 1),
        border-radius 420ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

.qr-shot--intro .qr-shot-canvas {
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
    .qr-shot--intro,
    .qr-shot--intro .qr-shot-canvas {
        transition: none;
    }

    .qr-shot-flash {
        display: none;
    }
}

.qr-shot-hint {
    position: absolute;
    top: 58px;
    left: 50%;
    max-width: calc(100% - 96px);
    margin: 0;
    padding: 7px 14px;
    border-radius: 999px;
    background: rgba(25, 25, 25, 0.82);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    color: #fff;
    font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    transform: translateX(-50%);
}

.qr-shot-hint-fade-enter-active,
.qr-shot-hint-fade-leave-active {
    transition: opacity 160ms ease;
}

.qr-shot-hint-fade-enter-from,
.qr-shot-hint-fade-leave-to {
    opacity: 0;
}

.qr-shot-actions {
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    max-width: calc(100% - 20px);
    color: #fff;
    font: 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
    white-space: nowrap;
}

.qr-shot-actions .qr-shot-btn--icon {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border-color: rgba(255, 255, 255, 0.72);
    border-radius: 50%;
    background: rgba(25, 25, 25, 0.82);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.qr-shot-actions .qr-shot-btn--icon svg {
    display: block;
    width: 16px;
    height: 16px;
}

.qr-shot-actions .qr-shot-btn--icon:hover {
    background: rgba(60, 60, 60, 0.92);
}

.qr-shot-actions .qr-shot-status {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 12px;
    border-radius: 999px;
    background: rgba(25, 25, 25, 0.82);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
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

.qr-shot-size {
    position: absolute;
    padding: 3px 8px;
    border-radius: 6px;
    background: rgba(25, 25, 25, 0.82);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    color: #fff;
    font: 12px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    transform: translateY(calc(-100% - 6px));
}

.qr-shot-status {
    padding: 0 4px;
    font-weight: 600;
    white-space: nowrap;
}

.qr-shot-status--success {
    color: #6ee7a8;
}

.qr-shot-status--error {
    color: #ff9b8f;
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

.qr-shot-btn.primary {
    border-color: rgba(255, 255, 255, 0.35);
    border-radius: 999px;
    background: rgba(60, 64, 72, 0.55);
    color: #fff;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
    backdrop-filter: blur(4px);
}

.qr-shot-btn.primary:hover {
    background: rgba(80, 85, 94, 0.75);
}

.qr-shot-btn--confirm {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    padding: 0;
}

.qr-shot-btn--confirm svg {
    display: block;
    width: 18px;
    height: 18px;
}

.qr-shot-close {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.72);
    border-radius: 50%;
    background: rgba(25, 25, 25, 0.82);
    color: #fff;
    cursor: pointer;
    font: 22px/26px Arial, sans-serif;
    text-align: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    transition: background-color 120ms ease, transform 120ms ease;
}

.qr-shot-close:hover {
    background: #d93025;
    transform: scale(1.08);
}
</style>
