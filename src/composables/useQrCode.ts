import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { createQrCodeSvg, toSvgDataUrl } from '@/services/qrCode';
import { t } from '@/services/i18n';

// 输入防抖: 连续敲字时不必每一帧都重新编码, 150ms 内没有新输入再渲染
const RENDER_DELAY = 150;

export function useQrCode(text: Ref<string>) {
    // 预览直接用矢量图; svg 留给下载时按需光栅化成 PNG
    const svg = ref('');
    const dataUrl = ref('');
    const error = ref('');
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
    };

    const clear = () => {
        svg.value = '';
        dataUrl.value = '';
    };

    const render = () => {
        clearTimer();
        const value = text.value;
        if (!value) {
            clear();
            error.value = '';
            return;
        }

        try {
            const markup = createQrCodeSvg(value);
            svg.value = markup;
            dataUrl.value = toSvgDataUrl(markup);
            error.value = '';
        } catch {
            // qrcode-generator 在内容超出容量时会直接抛错
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
