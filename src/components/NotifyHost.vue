<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
    cancelNotify,
    closeNotify,
    confirmNotify,
    extraNotify,
    notifyState,
} from '@/composables/useNotify';
import { copyText } from '@/services/clipboard';
import { isLinkText, toOpenableUrl } from '@/services/linkText';

// embedded: 在 popup 等紧凑容器中直接渲染为页面内容, 不再悬浮于内容之上
const props = defineProps<{ embedded?: boolean }>();
const embedded = computed(() => props.embedded === true);

const t = (
    key: 'closeBtn' | 'copied' | 'openLink' | 'copyItem' | 'copyAll' | 'showAll',
    fallback: string,
) => browser.i18n.getMessage(key) || fallback;

const options = computed(() => notifyState.options);
// 多码提示只说明"有几个码", 点"显示全部"才摊开列表: 展开后就按列表呈现,
// 不再走紧凑的 toast 样式
const expanded = ref(false);
const isToast = computed(() => options.value.toast === true && !expanded.value);
const listItems = computed(() => options.value.items ?? []);
const itemsCollapsed = computed(() => options.value.itemsCollapsed === true && !expanded.value);
const listVisible = computed(() => listItems.value.length > 0 && !itemsCollapsed.value);
// popup 内的 toast 只是过程提示, 不渲染操作按钮; 多结果列表使用自己的按钮;
// 通知靠关闭键收尾, 只有真实动作 (打开 / 复制 / 重试) 才铺操作区
const showActions = computed(
    () =>
        !(embedded.value && isToast.value) &&
        !listVisible.value &&
        Boolean(
            options.value.showCancelButton ||
                options.value.confirmButtonText ||
                options.value.onConfirm ||
                options.value.extraButtonText,
        ),
);
const icon = computed(() => options.value.icon ?? 'info');
const cancelText = computed(() => options.value.cancelButtonText || 'Cancel');
const copiedText = computed(() => t('copied', 'Copied'));

// 复制成功后仅改变对应按钮的文字, 鼠标移开后恢复
const copiedButton = ref<'confirm' | 'cancel' | null>(null);
const hoveredButton = ref<'confirm' | 'cancel' | null>(null);
// 多结果列表中已复制的条目, 以及"复制全部"的反馈
const copiedItem = ref<number | null>(null);
const copiedAll = ref(false);
let copiedItemTimer: number | undefined;

function clearCopiedItem() {
    if (copiedItemTimer !== undefined) {
        window.clearTimeout(copiedItemTimer);
        copiedItemTimer = undefined;
    }
    copiedItem.value = null;
    copiedAll.value = false;
}

watch(options, () => {
    copiedButton.value = null;
    hoveredButton.value = null;
    expanded.value = false;
    clearCopiedItem();
});

async function copyItem(index: number, text: string) {
    if (!(await copyText(text))) return;
    copiedAll.value = false;
    copiedItem.value = index;
    if (copiedItemTimer !== undefined) window.clearTimeout(copiedItemTimer);
    copiedItemTimer = window.setTimeout(() => {
        copiedItemTimer = undefined;
        copiedItem.value = null;
    }, 1600);
}

async function copyAll() {
    if (!listItems.value.length) return;
    if (!(await copyText(listItems.value.map((item) => item.text).join('\n')))) return;
    clearCopiedItem();
    copiedAll.value = true;
}

function openItem(text: string) {
    window.open(toOpenableUrl(text), '_blank');
}

const confirmLabel = computed(() =>
    copiedButton.value === 'confirm' ? copiedText.value : options.value.confirmButtonText ?? '',
);
const cancelLabel = computed(() =>
    copiedButton.value === 'cancel' ? copiedText.value : cancelText.value,
);

async function runAction(target: 'confirm' | 'cancel') {
    const handler = target === 'confirm' ? options.value.onConfirm : options.value.onCancel;
    if (!handler) {
        if (target === 'confirm') confirmNotify();
        else cancelNotify();
        return;
    }
    const success = await handler();
    // 复制完成时鼠标已移开则不再显示, 避免文字一直停留在已复制
    if (success && hoveredButton.value === target) copiedButton.value = target;
}

function onConfirm() {
    void runAction('confirm');
}

function onCancel() {
    void runAction('cancel');
}

function onMouseEnter(target: 'confirm' | 'cancel') {
    hoveredButton.value = target;
}

function onMouseLeave() {
    hoveredButton.value = null;
    copiedButton.value = null;
}

function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && notifyState.open) {
        closeNotify();
    }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown);
    clearCopiedItem();
});
</script>

<template>
    <Teleport to="body" :disabled="embedded">
        <Transition name="qr-notify-fade">
            <div
                v-if="notifyState.open"
                class="qr-notify-root"
                :class="{ 'qr-notify-root--embedded': embedded }"
            >
                <div
                    v-if="isToast && !embedded"
                    class="qr-notify-toast"
                    role="status"
                    aria-live="polite"
                >
                    <span v-if="notifyState.loading" class="qr-notify-spinner" aria-hidden="true"></span>
                    <span v-else class="qr-notify-icon" :class="`qr-notify-icon--${icon}`" aria-hidden="true">
                        <svg v-if="icon === 'success'" viewBox="0 0 24 24">
                            <path d="M20 6 9 17l-5-5" />
                        </svg>
                        <svg v-else-if="icon === 'error'" viewBox="0 0 24 24">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                        <svg v-else-if="icon === 'warning'" viewBox="0 0 24 24">
                            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                            <path d="M12 9v4M12 17h.01" />
                        </svg>
                        <svg v-else viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 16v-4M12 8h.01" />
                        </svg>
                    </span>

                    <div class="qr-notify-body">
                        <div v-if="options.title" class="qr-notify-title">{{ options.title }}</div>
                        <div v-if="options.text" class="qr-notify-text">{{ options.text }}</div>
                    </div>

                    <button
                        v-if="itemsCollapsed"
                        type="button"
                        class="qr-notify-item-btn qr-notify-more"
                        @click="expanded = true"
                    >{{ t('showAll', 'Show all') }}</button>

                    <button
                        v-if="options.showCloseButton"
                        type="button"
                        class="qr-notify-close"
                        :aria-label="t('closeBtn', 'Close')"
                        @click="closeNotify"
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <div v-else class="qr-notify-overlay" :class="{ 'qr-notify-overlay--embedded': embedded }">
                    <div
                        class="qr-notify-modal"
                        :class="{ 'qr-notify-modal--embedded': embedded }"
                        role="dialog"
                        :aria-modal="embedded ? undefined : 'true'"
                    >
                        <button
                            v-if="options.showCloseButton"
                            type="button"
                            class="qr-notify-close qr-notify-modal-close"
                            :aria-label="t('closeBtn', 'Close')"
                            @click="closeNotify"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                        </button>

                        <span v-if="notifyState.loading" class="qr-notify-spinner qr-notify-spinner--large" aria-hidden="true"></span>
                        <span v-else class="qr-notify-icon qr-notify-icon--large" :class="`qr-notify-icon--${icon}`" aria-hidden="true">
                            <svg v-if="icon === 'success'" viewBox="0 0 24 24">
                                <path d="M20 6 9 17l-5-5" />
                            </svg>
                            <svg v-else-if="icon === 'error'" viewBox="0 0 24 24">
                                <path d="M18 6 6 18M6 6l12 12" />
                            </svg>
                            <svg v-else-if="icon === 'warning'" viewBox="0 0 24 24">
                                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                                <path d="M12 9v4M12 17h.01" />
                            </svg>
                            <svg v-else viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10" />
                                <path d="M12 16v-4M12 8h.01" />
                            </svg>
                        </span>

                        <div class="qr-notify-body qr-notify-body--modal">
                            <div v-if="options.title" class="qr-notify-title qr-notify-title--modal">
                                {{ options.title }}
                            </div>
                            <div v-if="options.text" class="qr-notify-text qr-notify-text--modal">
                                {{ options.text }}
                            </div>

                            <div v-if="itemsCollapsed" class="qr-notify-actions">
                                <button
                                    type="button"
                                    class="qr-notify-btn qr-notify-btn--primary"
                                    @click="expanded = true"
                                >{{ t('showAll', 'Show all') }}</button>
                            </div>

                            <div v-if="listVisible" class="qr-notify-list">
                                <div
                                    v-for="(item, index) in listItems"
                                    :key="`${item.kind}-${index}`"
                                    class="qr-notify-item"
                                >
                                    <span
                                        class="qr-notify-item-badge"
                                        :class="{ 'qr-notify-item-badge--barcode': item.kind === 'barcode' }"
                                    >{{ item.kind === 'barcode' ? '1D' : 'QR' }}</span>
                                    <span class="qr-notify-item-text">{{ item.text }}</span>
                                    <span class="qr-notify-item-actions">
                                        <button
                                            v-if="isLinkText(item.text)"
                                            type="button"
                                            class="qr-notify-item-btn"
                                            @click="openItem(item.text)"
                                        >{{ t('openLink', 'Open') }}</button>
                                        <button
                                            type="button"
                                            class="qr-notify-item-btn"
                                            @click="copyItem(index, item.text)"
                                        >{{ copiedItem === index ? t('copied', 'Copied') : t('copyItem', 'Copy') }}</button>
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div v-if="listVisible" class="qr-notify-actions">
                            <button type="button" class="qr-notify-btn qr-notify-btn--primary" @click="copyAll">
                                {{ copiedAll ? t('copied', 'Copied') : t('copyAll', 'Copy all') }}
                            </button>
                        </div>

                        <div v-if="showActions" class="qr-notify-actions">
                            <button
                                v-if="options.showCancelButton"
                                type="button"
                                class="qr-notify-btn"
                                @click="onCancel"
                                @mouseenter="onMouseEnter('cancel')"
                                @mouseleave="onMouseLeave"
                            >
                                {{ cancelLabel }}
                            </button>
                            <button
                                v-if="options.confirmButtonText || options.onConfirm"
                                type="button"
                                class="qr-notify-btn"
                                :class="{ 'qr-notify-btn--primary': !options.extraButtonText }"
                                @click="onConfirm"
                                @mouseenter="onMouseEnter('confirm')"
                                @mouseleave="onMouseLeave"
                            >
                                {{ confirmLabel }}
                            </button>
                            <button
                                v-if="options.extraButtonText"
                                type="button"
                                class="qr-notify-btn qr-notify-btn--primary"
                                @click="extraNotify"
                            >
                                {{ options.extraButtonText }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.qr-notify-root {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    color: #1f2937;
    font-size: 14px;
    line-height: 1.5;
    text-align: left;
}

/* popup 内: 通知就是 popup 的内容, 不浮层、不留边.
   投影仍照画: 弹窗窗口按内容尺寸成型会把它裁掉, 只有用标签页打开 popup 页面时
   才有页面背景接住这层投影, 通知才像浮在页面上的一张卡片.
   不开圆角: 圆角处会漏出投影, 弹窗里就成了四个脏角 */
.qr-notify-root--embedded {
    position: relative;
    inset: auto;
    /* 固定宽度: popup 打开后浏览器不会再缩小窗口, 宽度随内容变化会显得忽宽忽窄 */
    width: 360px;
    min-width: 360px;
    pointer-events: auto;
    background: #fff;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
}

.qr-notify-toast,
.qr-notify-modal {
    box-sizing: border-box;
    background: #fff;
    color: #1f2937;
    border-radius: 12px;
    box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18);
}

.qr-notify-toast {
    position: absolute;
    top: 16px;
    right: 16px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: max-content;
    max-width: min(420px, calc(100vw - 32px));
    padding: 12px 14px;
    pointer-events: auto;
}

.qr-notify-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(15, 23, 42, 0.45);
    pointer-events: auto;
}

.qr-notify-overlay--embedded {
    position: static;
    inset: auto;
    box-sizing: border-box;
    width: 100%;
    padding: 20px 18px;
    background: transparent;
}

.qr-notify-modal {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min(420px, 100%);
    max-height: calc(100vh - 48px);
    padding: 24px 20px 20px;
    overflow: auto;
    text-align: center;
}

.qr-notify-modal--embedded {
    width: 100%;
    max-height: none;
    padding: 4px 0 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    overflow: visible;
}

.qr-notify-body {
    flex: 1;
    min-width: 0;
}

.qr-notify-body--modal {
    width: 100%;
    margin-top: 12px;
}

.qr-notify-title {
    font-size: 14px;
    font-weight: 600;
    color: #111827;
    word-break: break-word;
}

.qr-notify-title--modal {
    font-size: 18px;
}

.qr-notify-text {
    margin-top: 4px;
    font-size: 13px;
    color: #4b5563;
    word-break: break-word;
    white-space: pre-wrap;
}

.qr-notify-text--modal {
    margin-top: 8px;
    font-size: 14px;
    word-break: break-all;
}

/* 页面全局样式会泄漏进注入的 UI（如 example.com 的 svg 外边距规则），把图标拉回原位 */
.qr-notify-root svg {
    margin: 0;
    opacity: 1;
}

.qr-notify-icon {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
}

.qr-notify-icon svg {
    width: 70%;
    height: 70%;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.qr-notify-icon--large {
    width: 52px;
    height: 52px;
}

.qr-notify-icon--info {
    color: #2563eb;
    background: #dbeafe;
}

.qr-notify-icon--success {
    color: #16a34a;
    background: #dcfce7;
}

.qr-notify-icon--error {
    color: #dc2626;
    background: #fee2e2;
}

.qr-notify-icon--warning {
    color: #d97706;
    background: #fef3c7;
}

.qr-notify-spinner {
    flex: none;
    width: 20px;
    height: 20px;
    border: 2px solid #bfdbfe;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: qr-notify-spin 0.8s linear infinite;
}

.qr-notify-spinner--large {
    width: 44px;
    height: 44px;
    border-width: 3px;
}

@keyframes qr-notify-spin {
    to {
        transform: rotate(360deg);
    }
}

/* toast 形态里的"显示全部": 贴在关闭按钮左侧, 与正文垂直居中 */
.qr-notify-more {
    flex: none;
    align-self: center;
    margin-right: 6px;
}

.qr-notify-close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    transition: color 0.15s, background-color 0.15s;
}

.qr-notify-close svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
}

.qr-notify-close:hover {
    color: #374151;
    background: #f3f4f6;
}

.qr-notify-modal-close {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 28px;
    height: 28px;
}

.qr-notify-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-height: min(46vh, 320px);
    margin-top: 14px;
    overflow: auto;
    text-align: left;
}

.qr-notify-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #f9fafb;
}

.qr-notify-item-badge {
    flex: none;
    min-width: 26px;
    margin-top: 1px;
    padding: 1px 4px;
    border-radius: 4px;
    background: #dbeafe;
    color: #2563eb;
    font-size: 11px;
    font-weight: 600;
    text-align: center;
}

.qr-notify-item-badge--barcode {
    background: #fef3c7;
    color: #b45309;
}

.qr-notify-item-text {
    flex: 1;
    min-width: 0;
    color: #374151;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-all;
    white-space: pre-wrap;
}

.qr-notify-item-actions {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
}

.qr-notify-item-btn {
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: #2563eb;
    font: inherit;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
}

.qr-notify-item-btn:hover {
    text-decoration: underline;
}

.qr-notify-actions {
    display: flex;
    justify-content: center;
    gap: 10px;
    width: 100%;
    margin-top: 20px;
}

.qr-notify-btn {
    /* 让三到四个单词的英文标签单行排下: 上限偏小时 "Select Smaller Region" 会被折成两行 */
    max-width: 220px;
    min-width: 92px;
    box-sizing: border-box;
    padding: 8px 16px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    color: #374151;
    font: inherit;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
}

.qr-notify-btn:hover {
    background: #f9fafb;
    border-color: #9ca3af;
}

.qr-notify-btn--primary {
    border-color: #2563eb;
    background: #2563eb;
    color: #fff;
}

.qr-notify-btn--primary:hover {
    border-color: #1d4ed8;
    background: #1d4ed8;
}

.qr-notify-fade-enter-active,
.qr-notify-fade-leave-active {
    transition: opacity 0.18s ease;
}

.qr-notify-fade-enter-active .qr-notify-toast,
.qr-notify-fade-leave-active .qr-notify-toast,
.qr-notify-fade-enter-active .qr-notify-modal,
.qr-notify-fade-leave-active .qr-notify-modal {
    transition: transform 0.18s ease;
}

.qr-notify-fade-enter-from,
.qr-notify-fade-leave-to {
    opacity: 0;
}

.qr-notify-fade-enter-from .qr-notify-toast,
.qr-notify-fade-leave-to .qr-notify-toast {
    transform: translateY(-8px);
}

.qr-notify-fade-enter-from .qr-notify-modal,
.qr-notify-fade-leave-to .qr-notify-modal {
    transform: scale(0.96);
}

/* popup 内通知不缩放, 只做淡入淡出 */
.qr-notify-fade-enter-from .qr-notify-modal--embedded,
.qr-notify-fade-leave-to .qr-notify-modal--embedded {
    transform: none;
}
</style>
