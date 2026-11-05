import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { createQrCodeSvg, svgToPngDataUrl } from '@/services/qrCode';
import { t } from '@/services/i18n';

// 输入防抖: 连续敲字时不必每一帧都重新编码, 150ms 内没有新输入再渲染
const RENDER_DELAY = 150;

export function useQrCode(text: Ref<string>) {
    // svg 只留给 SVG 下载, 预览 / 复制 / PNG 下载统一用光栅化后的位图
    const svg = ref('');
    const dataUrl = ref('');
    const error = ref('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 光栅化是异步的: 用序号丢弃上一轮结果, 否则快速输入时会闪回旧二维码
    let renderId = 0;

    const clearTimer = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
    };

    const clear = () => {
        svg.value = '';
        dataUrl.value = '';
    };

    const render = async () => {
        clearTimer();
        const value = text.value;
        const id = ++renderId;
        if (!value) {
            clear();
            error.value = '';
            return;
        }

        let markup: string;
        try {
            markup = createQrCodeSvg(value);
        } catch {
            // qrcode-generator 在内容超出容量时会直接抛错
            clear();
            error.value = t('qrGenerateFailed');
            return;
        }
        svg.value = markup;

        try {
            const png = await svgToPngDataUrl(markup);
            if (id !== renderId) return;
            dataUrl.value = png;
            error.value = '';
        } catch {
            if (id !== renderId) return;
            clear();
            error.value = t('qrGenerateFailed');
        }
    };

    watch(
        text,
        () => {
            clearTimer();
            // 首次渲染(打开 popup 或页面)不等防抖, 避免先闪一下空状态
            if (!dataUrl.value && !error.value) {
                render();
                return;
            }
            timer = setTimeout(render, RENDER_DELAY);
        },
        { immediate: true },
    );

    onScopeDispose(clearTimer);

    return { svg, dataUrl, error };
}
