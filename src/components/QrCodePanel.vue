<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQrCode } from '@/composables/useQrCode';
import { copyImageDataUrl } from '@/services/clipboardImage';
import { toSvgDataUrl } from '@/services/qrCode';
import { t } from '@/services/i18n';

// 二维码生成面板: 默认只显示二维码, 点二维码展开输入框
const props = withDefaults(
    defineProps<{
        modelValue?: string;
        collapsible?: boolean;
        // 叠在二维码上的一闪而过的文案 (popup 里右键扫自己的二维码时用), 不占面板尺寸
        flashText?: string;
    }>(),
    { modelValue: '', collapsible: false, flashText: '' },
);

const emit = defineEmits<{
    (event: 'update:modelValue', value: string): void;
    // 扫码入口只负责发出意图, 具体分发交给宿主 (popup 交给后台)
    (event: 'scan', entry: 'image' | 'screen' | 'camera'): void;
}>();

const text = computed({
    get: () => props.modelValue,
    set: (value: string) => emit('update:modelValue', value),
});

const { svg, dataUrl, error } = useQrCode(text);

const inputRef = ref<HTMLTextAreaElement>();
const expanded = ref(!props.collapsible);

// 输入框平时只显示占位提示, 聚焦后才露出当前文字 (预填的长链接不占着位置);
// 用户亲手改过之后就一直显示内容, 失焦不再退回提示语, 否则刚输入的文字像是没生效
const inputFocused = ref(false);
const inputEdited = ref(false);

function onInputInput(event: Event) {
    inputEdited.value = true;
    text.value = (event.target as HTMLTextAreaElement).value;
}

function onInputFocus() {
    inputFocused.value = true;
}

function onInputBlur() {
    inputFocused.value = false;
}

// 文本框按内容行数长高: 多行文本整段看得见, 不用在框里滚动.
// 空值时 scrollHeight 已含换行后的占位提示高度 (Chrome / Firefox 实测), 所以下限写一行即可.
// 先归零才能让 scrollHeight 反映真实内容高度, 再加上边框, 否则 border-box 会矮 2px
function fitInputHeight() {
    const input = inputRef.value;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

// 显示出来的内容变了 (含聚焦态切换与外部换文本) 与抽屉展开时都要重算
watch(
    [() => (inputFocused.value || inputEdited.value ? text.value : ''), expanded],
    async () => {
        if (!expanded.value) return;
        await nextTick();
        fitInputHeight();
    },
    { flush: 'post' },
);

onMounted(fitInputHeight);

// 二维码整块就是展开/收起入口, 没有再叠一个可见按钮
function toggleExpanded() {
    if (props.collapsible) expanded.value = !expanded.value;
}

// 抽屉里复制按钮就地反馈结果: 成功换成对勾, 失败换回图标并短暂给出失败提示
const copyState = ref<'idle' | 'done' | 'failed'>('idle');
let copyTimer: number | undefined;

function setCopyState(state: 'done' | 'failed') {
    copyState.value = state;
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
        copyTimer = undefined;
        copyState.value = 'idle';
    }, 1500);
}

const copyLabel = computed(() => {
    if (copyState.value === 'done') return t('copied');
    if (copyState.value === 'failed') return t('screenshotCopyFailed');
    return t('qrCopy');
});

async function copyQrCode() {
    if (!dataUrl.value) return;
    setCopyState((await copyImageDataUrl(dataUrl.value)) ? 'done' : 'failed');
}

// 两种格式都直接取现成结果: PNG 就是预览用的位图, SVG 是它的矢量源, 不再重新编码
function downloadQrCode(format: 'png' | 'svg') {
    const href = format === 'svg' ? toSvgDataUrl(svg.value) : dataUrl.value;
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.download = `${t('qrFileName')}.${format}`;
    link.click();
}

onBeforeUnmount(() => {
    if (copyTimer !== undefined) window.clearTimeout(copyTimer);
});
</script>

<template>
    <section class="qr-panel" :class="{ 'qr-panel--compact': !expanded }">
        <div
            class="qr-panel-preview"
            :class="{ 'qr-panel-preview--toggle': collapsible }"
            @click="collapsible && toggleExpanded()"
        >
            <img
                v-if="dataUrl"
                class="qr-panel-image"
                :src="dataUrl"
                :alt="text"
                :title="text"
            />
            <p v-else-if="error" class="qr-panel-error">{{ error }}</p>
            <p v-else class="qr-panel-hint">{{ t('qrEmptyHint') }}</p>

            <!-- 点击整块二维码展开/收起; 键盘入口仍是这个按钮, 鼠标点击冒泡到预览容器.
                 按钮不接收指针, 否则右键命中的是按钮而不是 <img>, 浏览器只给 page 上下文的菜单,
                 连图片扫描那一项都不会出现 -->
            <button
                v-if="collapsible"
                class="qr-panel-toggle"
                type="button"
                :aria-expanded="expanded"
                :aria-label="expanded ? t('collapseEditor') : t('moreOptions')"
                :title="expanded ? t('collapseEditor') : t('moreOptions')"
            ></button>

            <!-- 临时提示叠在二维码上而不是面板外面:
                 抽屉展开时它也贴着二维码, 不跟着面板下沿跑 -->
            <Transition name="qr-panel-flash">
                <p v-if="flashText" class="qr-panel-flash" role="status">{{ flashText }}</p>
            </Transition>
        </div>

        <Transition name="qr-drawer">
            <div v-if="expanded" class="qr-panel-drawer">
                <div class="qr-panel-drawer-clip">
                    <div class="qr-panel-expanded">
                        <!-- 文本框: 高度随内容行数长高, 占位提示换行也整句可见 -->
                        <textarea
                            id="qr-panel-input"
                            ref="inputRef"
                            :value="inputFocused || inputEdited ? text : ''"
                            class="qr-panel-input"
                            rows="1"
                            spellcheck="false"
                            :placeholder="t('qrInputPlaceholder')"
                            @input="onInputInput"
                            @focus="onInputFocus"
                            @blur="onInputBlur"
                        ></textarea>

                        <!-- 复制 / 下载收进抽屉: 悬停浮层会挡住二维码热区, 也不便在触屏上触发 -->
                        <div v-if="dataUrl" class="qr-panel-actions">
                            <button
                                class="qr-panel-action"
                                :class="
                                    copyState === 'done'
                                        ? 'qr-panel-action--copied'
                                        : 'qr-panel-action--copy'
                                "
                                type="button"
                                :aria-label="copyLabel"
                                :title="copyLabel"
                                @click="copyQrCode"
                            ></button>
                            <button
                                class="qr-panel-action qr-panel-action--format"
                                type="button"
                                :aria-label="t('qrDownloadPng')"
                                :title="t('qrDownloadPng')"
                                @click="downloadQrCode('png')"
                            >
                                PNG
                            </button>
                            <button
                                class="qr-panel-action qr-panel-action--format"
                                type="button"
                                :aria-label="t('qrDownloadSvg')"
                                :title="t('qrDownloadSvg')"
                                @click="downloadQrCode('svg')"
                            >
                                SVG
                            </button>
                        </div>

                        <div class="qr-panel-actions">
                            <button
                                class="qr-panel-action qr-panel-action--camera"
                                type="button"
                                :aria-label="t('scanCamera')"
                                :title="t('scanCamera')"
                                @click="emit('scan', 'camera')"
                            ></button>
                            <button
                                class="qr-panel-action qr-panel-action--screen"
                                type="button"
                                :aria-label="t('scanScreen')"
                                :title="t('scanScreen')"
                                @click="emit('scan', 'screen')"
                            ></button>
                            <button
                                class="qr-panel-action qr-panel-action--image"
                                type="button"
                                :aria-label="t('scanLocalImage')"
                                :title="t('scanLocalImage')"
                                @click="emit('scan', 'image')"
                            ></button>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </section>
</template>

<style scoped>
.qr-panel {
    /* 二维码结果动作图标: 复制 / 下载 / 复制成功 */
    --qr-copy: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5.5' y='5.5' width='8' height='8' rx='1.5'/%3E%3Cpath d='M10.5 3.5h-6A1.5 1.5 0 0 0 3 5v6'/%3E%3C/svg%3E");
    --qr-download: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 2.5v7'/%3E%3Cpath d='m5 6.5 3 3 3-3'/%3E%3Cpath d='M3 12.5h10'/%3E%3C/svg%3E");
    --qr-check: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 8.5 3 3 6-7'/%3E%3C/svg%3E");
    /* 扫码入口图标: 图片 / 屏幕 / 摄像头, 画成单色由 currentColor 上色 */
    --qr-scan-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='2' y='2.5' width='12' height='11' rx='1.5'/%3E%3Ccircle cx='5.5' cy='6' r='1'/%3E%3Cpath d='m2.5 11.5 3.2-3.2 2.4 2.4 2-2 3.4 3.4'/%3E%3C/svg%3E");
    --qr-scan-screen: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='1.5' y='2.5' width='13' height='9' rx='1.5'/%3E%3Cpath d='M8 11.5v2'/%3E%3Cpath d='M5.5 14h5'/%3E%3Cpath d='M4.5 7h7'/%3E%3C/svg%3E");
    --qr-scan-camera: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 4.5 7 3h2l1 1.5h2.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V6a1.5 1.5 0 0 1 1.5-1.5z'/%3E%3Ccircle cx='8' cy='9' r='2.4'/%3E%3C/svg%3E");
    position: relative;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    width: 220px;
    padding: 0;
}

.qr-panel-preview {
    position: relative;
    /* 压住抽屉内容, 让底部投影落在拉出来的抽屉上 */
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 220px;
    height: 220px;
    margin: 0 auto;
}

/* 展开后二维码盖在抽屉上方: 底部投影体现两层的前后关系, 收起时下面没有东西就不投影.
   投影画在伪元素上只渐变不透明度: 直接过渡 box-shadow 会让 Firefox 每帧重画 220px 宽的
   模糊阴影, 展开动画期间就是掉帧; 不透明度可以交给合成器做 */
.qr-panel-preview::after {
    content: '';
    position: absolute;
    inset: 0;
    box-shadow: 0 6px 10px -6px rgba(15, 23, 42, 0.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity 220ms ease;
    will-change: opacity;
}

.qr-panel:not(.qr-panel--compact) .qr-panel-preview::after {
    opacity: 1;
}

.qr-panel-image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.qr-panel-hint,
.qr-panel-error {
    margin: 0;
    padding: 0 12px;
    font-size: 13px;
    line-height: 1.5;
    text-align: center;
}

.qr-panel-hint {
    color: #94a3b8;
}

.qr-panel-error {
    color: #dc2626;
}

/* 临时提示: 半透明遮罩铺满整个码面, 文案居中, 不参与布局也不撑开面板尺寸 */
.qr-panel-flash {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    /* 压住二维码图片和预览底部的投影 */
    z-index: 2;
    margin: 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 13px;
    line-height: 1.45;
    text-align: center;
    /* 只是顺带逗一句 / 报个状态, 点击照常落到二维码热区 */
    pointer-events: none;
}

.qr-panel-flash-enter-active,
.qr-panel-flash-leave-active {
    transition: opacity 0.16s ease;
}

.qr-panel-flash-enter-from,
.qr-panel-flash-leave-to {
    opacity: 0;
}

/* 展开区按 grid 行高 0fr → 1fr 撑开: 内容始终在顶部, 窗口拉多高就露出多少,
   不会随外框平移 —— 内容每帧不用重排重绘, 也省掉火狐上那层逐帧重画的开销.
   想再叠 transform 平移做抽屉的话, 位移曲线跟 grid 实际撑高对不上, 底边会被切掉.
   宽度必须写满: .qr-panel 是 align-items: center 的纵向 flex, 子项默认按内容收缩,
   抽屉会被输入框的固有宽度缩成一条窄带, 两边留出比 padding 厚得多的空白 */
.qr-panel-drawer {
    display: grid;
    grid-template-rows: 1fr;
    width: 100%;
    transition: grid-template-rows 220ms ease;
}

/* 内容跟着外框一起长: 下拉时画面原地显形, 内容本身不动, 不用每帧重排重绘;
   用 clip 而不是 hidden: hidden 会把这里变成滚动容器, Firefox 得每帧重算可滚动区域 */
.qr-panel-drawer-clip {
    min-height: 0;
    overflow: clip;
}

.qr-drawer-enter-from,
.qr-drawer-leave-to {
    grid-template-rows: 0fr;
}

.qr-panel-expanded {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* 顶部留白给二维码下方的投影让位, 展开时输入框不会被压暗 */
    padding: 8px;
}

/* 展开后才出现扫描入口: 收起态只留二维码, 避免入口挤占预览 */
.qr-panel-actions {
    display: flex;
    gap: 8px;
}

.qr-panel-action {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    height: 28px;
    padding: 0;
    color: #475569;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    border-radius: 4px;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
}

.qr-panel-action:hover {
    color: #0f172a;
    background: #e2e8f0;
}

.qr-panel-action:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: -1px;
}

.qr-panel-action::before {
    content: '';
    width: 16px;
    height: 16px;
    background: currentColor;
    -webkit-mask: var(--qr-action-icon) center / 16px 16px no-repeat;
    mask: var(--qr-action-icon) center / 16px 16px no-repeat;
}

.qr-panel-action--image {
    --qr-action-icon: var(--qr-scan-image);
}

.qr-panel-action--screen {
    --qr-action-icon: var(--qr-scan-screen);
}

.qr-panel-action--camera {
    --qr-action-icon: var(--qr-scan-camera);
}

.qr-panel-action--copy {
    --qr-action-icon: var(--qr-copy);
}

.qr-panel-action--copied {
    --qr-action-icon: var(--qr-check);
}

/* 两个下载按钮共用下载图标, 后缀标明导出的格式 */
.qr-panel-action--format {
    --qr-action-icon: var(--qr-download);
    gap: 4px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
}

/* 高度下限一行 (1.5em 行高 + padding 与边框), 上限 25vh 后转为框内滚动,
   抽屉不会跟着无限长; 实际高度由脚本按内容贴上去 */
.qr-panel-input {
    box-sizing: border-box;
    display: block;
    width: 100%;
    min-height: calc(1.5em + 10px);
    max-height: 25vh;
    overflow-y: auto;
    padding: 4px 6px;
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    color: #1f2937;
    background: #ffffff;
    border: 1px solid #cbd5e1;
    border-radius: 4px;
    outline: none;
    resize: none;
}

/* 居中的只有未聚焦时的占位提示: 聚焦时若也让输入框居中, 清空内容后光标会停在正中间,
   接着输入的字也从中间往外长; 聚焦态一律靠左, 提示语回到中间只在失焦后发生 */
.qr-panel-input:placeholder-shown:not(:focus) {
    text-align: center;
}

/* 聚焦不改变边框与背景, 没有任何高亮效果 */
.qr-panel-input:focus,
.qr-panel-input:focus-visible {
    border-color: #cbd5e1;
    box-shadow: none;
    outline: none;
}

/* 展开入口: 整块二维码都是热区, 平时完全透明, 键盘聚焦时给出描边.
   按钮只留给键盘, 不接收指针——鼠标点击由 .qr-panel-preview 处理.
   否则右键落在按钮上, 浏览器按 page 上下文出菜单, 图片相关的菜单项不会出现 */
.qr-panel-toggle {
    position: absolute;
    inset: 0;
    padding: 0;
    background: transparent;
    border: 0;
    pointer-events: none;
}

.qr-panel-preview--toggle {
    cursor: pointer;
}

.qr-panel-toggle:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: -1px;
}
</style>
