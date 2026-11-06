<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import type { ScanRect } from '@/components/ScanAnimation.vue';
import { overlayMountPoint, overlayZIndex } from '@/services/overlayHost';
import { t } from '@/services/i18n';

// 扫描命中后标出码的位置: 每个码上叠可点击绿点, 由用户选用哪一个
// picked 标出已经点开过的码: 这些码只留绿框做位置标记, 圆点摘掉
// anchor 传图片元素时绿框跟随图片所在层, 只压住图片而不遮挡页面自己的浮层(如维基的下载面板);
// 整屏截图等没有实体图片的场景不传, 仍覆盖整个视口
const props = defineProps<{ rects: ScanRect[]; anchor?: Element | null; picked?: boolean[] }>();
const emit = defineEmits<{ pick: [index: number]; dismiss: [] }>();

// 绿点只用来在多个码之间做选择: 只有一个码时不需要它
const showDots = computed(() => props.rects.length > 1);
const isPicked = (index: number) => props.picked?.[index] === true;

// 点过的码不再重复点开; 单码的结果通知已经展示过这个码,
// 绿框只作位置标记, 否则关掉通知后还能一遍遍点出同一条结果
function pick(index: number) {
    if (!showDots.value || isPicked(index)) return;
    emit('pick', index);
}

// 点框内的分工: 还没点过的码把通知切到它; 已经看过的灰框与单码框与点空白同一条收尾,
// 只是拦下这次点击不传给网页, 由宿主觉得是收标记还是退出
function activate(index: number) {
    if (showDots.value && !isPicked(index)) {
        emit('pick', index);
        return;
    }
    emit('dismiss');
}

const pickHint = t('pickCodeHint');

// 修复绿框消失时连闪几下: 清标记的同时锚点也会变成空, Teleport 的挂载点当场从图片容器切回原位,
// Vue 只好重建整个标记层, 绿框的入场动画与整层的退场淡出都从第一帧重放, 看上去就是闪了好几次。
// 因此只在拿到锚点时更新它, 收起阶段继续挂在上一次的锚点里, 让退场在原地安静淡出
const lastAnchor = ref<Element | null>(null);
watch(() => props.anchor, (anchor) => {
    if (anchor) lastAnchor.value = anchor;
}, { immediate: true });

const anchored = computed(() => (lastAnchor.value ? overlayMountPoint(lastAnchor.value) : null));
// 只有真的挂进了图片所在容器才交给页面层级; 退回 body 时仍需覆盖视口的最高层, 否则会被页面浮层盖住
const inPageLayer = computed(() => anchored.value !== null && anchored.value !== document.body);
const rootStyle = computed(() => (inPageLayer.value ? { zIndex: overlayZIndex(lastAnchor.value) ?? 'auto' } : undefined));

const rectStyle = (rect: ScanRect) => ({
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
});

// 绿点压在码中央: 尺寸跟随码的大小, 小码也留出足够的可点面积
function dotStyle(rect: ScanRect) {
    const size = Math.round(Math.min(56, Math.max(26, Math.min(rect.width, rect.height) * 0.42)));
    return { width: `${size}px`, height: `${size}px` };
}
</script>

<template>
    <Teleport :to="anchored ?? 'body'" :disabled="!anchored">
        <Transition name="qr-marks-fade">
            <div v-if="props.rects.length" class="qr-marks-root" :style="rootStyle">
                <div
                    v-for="(rect, index) in props.rects"
                    :key="index"
                    class="qr-marks-item"
                    :class="{ 'qr-marks-item--picked': isPicked(index) }"
                    :style="rectStyle(rect)"
                    @click.stop.prevent="activate(index)"
                >
                    <span class="qr-marks-box" />
                    <!-- 单个码不叠绿点: 绿点是给多码点选用的, 只有一个码时结果通知已经展示过,
                         点还压在码中央会挡住内容; 这块框只标位置, 点一下直接退出 -->
                    <button
                        v-if="showDots && !isPicked(index)"
                        type="button"
                        class="qr-marks-dot"
                        :style="dotStyle(rect)"
                        :title="pickHint"
                        :aria-label="pickHint"
                        @click.stop.prevent="pick(index)"
                    >
                        <!-- 修复点绿点会顺带触发下层交互的问题:
                             绿框挂在图片所在容器里, 点击继续冒泡会被当成点了图片/面板
                             (网页打开看图浮层、面板重新弹出选文件), 上面已就地截断这次点击 -->
                        <!-- 实现"点绿点看信息"的语义: 点绿点只是把通知切到这个码的扫描结果,
                             并不打开链接, 用箭头容易被当成跳转, 改为字母 i -->
                        <svg class="qr-marks-dot-icon" viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 11v6" />
                            <path d="M12 7h.01" />
                        </svg>
                    </button>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.qr-marks-root {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    overflow: hidden;
    pointer-events: none;
}

/* 页面全局样式会泄漏进注入的 UI, 这里显式兜底边距、透明度与盒模型 */
.qr-marks-item {
    position: absolute;
    box-sizing: content-box;
    margin: 0;
    padding: 0;
    opacity: 1;
    animation: qr-marks-pop 200ms ease both;
    /* 整个绿框区域都能点选: 不必非得点中中间的小绿点;
       点过的码与单码点一下就是退出(也顺带挡住点击, 免得穿到网页触发下层交互) */
    pointer-events: auto;
    cursor: pointer;
}

/* 点过的码把绿框转灰并去掉荧光: 一眼分清"看过"和"还没点"的码 */
.qr-marks-item--picked .qr-marks-box {
    border-color: #9ca3af;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.22);
}

.qr-marks-box {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 0;
    opacity: 1;
    border: 2px solid #22c55e;
    border-radius: 6px;
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(34, 197, 94, 0.55);
}

/* 只有绿点接管点击: 空白点击由 useCodePicker 在 document 上判断, 不挡住页面与面板按钮 */
.qr-marks-dot {
    position: absolute;
    inset: 0;
    box-sizing: border-box;
    margin: auto;
    padding: 0;
    opacity: 1;
    appearance: none;
    border: 2px solid #fff;
    border-radius: 50%;
    background: #22c55e;
    box-shadow:
        0 0 0 2px rgba(34, 197, 94, 0.55),
        0 2px 8px rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    pointer-events: auto;
    transition:
        transform 140ms ease,
        background-color 140ms ease;
}

.qr-marks-dot:hover {
    transform: scale(1.08);
    background: #16a34a;
}

.qr-marks-dot:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
}

.qr-marks-dot-icon {
    width: 62%;
    height: 62%;
    margin: 0;
    padding: 0;
    opacity: 1;
    fill: none;
    stroke: #fff;
    stroke-width: 2.6;
    stroke-linecap: round;
    stroke-linejoin: round;
}

@keyframes qr-marks-pop {
    from {
        opacity: 0;
        transform: scale(1.06);
    }

    to {
        opacity: 1;
        transform: scale(1);
    }
}

.qr-marks-fade-enter-active,
.qr-marks-fade-leave-active {
    transition: opacity 200ms ease;
}

.qr-marks-fade-enter-from,
.qr-marks-fade-leave-to {
    opacity: 0;
}
</style>
