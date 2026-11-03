import { isLinkText, toOpenableUrl } from '@/services/linkText';
import type { NotifyResultItem } from '@/composables/useNotify';
import type { PopupNoticeAction, PopupNoticePayload } from '@/services/popupNotice';
import type { DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { copyText } from '@/services/clipboard';

// 扫描过程中的加载提示: 由调用方替换为结果通知
export function decodingNotice(): PopupNoticePayload {
    return {
        options: {
            toast: true,
            icon: 'info',
            title: t('decodingQR'),
            showCloseButton: true,
            loading: true,
        },
    };
}

// 通用警告提示 (轻量 toast)
export function warningNotice(title: string, text?: string): PopupNoticePayload {
    return {
        options: {
            toast: true,
            icon: 'warning',
            title,
            text,
            showCloseButton: true,
        },
    };
}

// 通用错误提示
export function errorNotice(title: string, text?: string): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'error',
            title,
            text,
            confirmButtonText: t('confirm'),
            showCloseButton: true,
        },
    };
}

// 图片读取失败 (典型是跨域图片污染 canvas 导致无法取像素):
// 除确认外提供"改用截图扫描", 由 popup 或页面内兜底通知执行
export function errorNoticeWithScreenshot(
    title: string,
    text?: string,
): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'error',
            title,
            text,
            confirmButtonText: t('confirm'),
            extraButtonText: t('screenshotScan'),
            showCloseButton: true,
        },
        extraAction: { kind: 'screenshot' },
    };
}

// 扫描结果的通用通知构造: content / popup / capture 三个入口共用同一套分支
// (无结果重试 → 多码列表 → 单码链接/复制), 避免各写一遍文案与动作

// 未扫描到任何码
function noResultNotice(retryScreenshot: boolean): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'warning',
            title: t('recognitionFailed'),
            text: t('recognitionFailedMsg'),
            showCloseButton: true,
        },
        extraAction: retryScreenshot ? { kind: 'screenshot' } : undefined,
    };
}

// 多个结果: 逐条列出, 由用户分别打开/复制
function multiResultNotice(results: DecodeResult[]): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'success',
            title: t('multiScanSuccess'),
            items: toNoticeItems(results),
            showCloseButton: true,
        },
    };
}

// 单个结果: 链接提供"打开/复制", 纯文本只提供"复制"
function singleResultNotice(result: DecodeResult): PopupNoticePayload {
    const isLink = isLinkText(result.text);
    return {
        options: {
            toast: false,
            icon: 'success',
            title: t(result.kind === 'barcode' ? 'barcodeScanSuccess' : 'qrcodeScanSuccess'),
            text: result.text,
            showCancelButton: isLink,
            confirmButtonText: isLink ? t('openLink') : t('copyContent'),
            cancelButtonText: isLink ? t('copyLink') : undefined,
            showCloseButton: true,
        },
        confirmAction: isLink
            ? { kind: 'open', value: result.text }
            : { kind: 'copy', value: result.text },
        cancelAction: isLink ? { kind: 'copy', value: result.text } : undefined,
    };
}

// 按结果数量选择对应的通知。
// retryScreenshot: 当前入口能否真的再截一次图 (独立扫描页里截图只会截到自己, 传 false)
export function resultNotice(
    results: DecodeResult[],
    options: { retryScreenshot?: boolean } = {},
): PopupNoticePayload {
    if (!results.length) return noResultNotice(options.retryScreenshot ?? true);
    if (results.length > 1) return multiResultNotice(results);
    return singleResultNotice(results[0]!);
}

// 通知动作对应的文案与本地执行函数: 页面内兜底通知无法跨进程执行动作,
// 需要用同一份 action 描述在本进程内执行
export function runNoticeAction(action?: PopupNoticeAction): void {
    if (!action) return;
    if (action.kind === 'open') {
        window.open(toOpenableUrl(action.value), '_blank');
    }
}

function toNoticeItems(results: DecodeResult[]): NotifyResultItem[] {
    return results.map((result) => ({ text: result.text, kind: result.kind }));
}

// 页面内兜底通知的复制处理器: 复制按钮不结束通知, 成功后按钮文字变为已复制
export function copyHandlers(payload: PopupNoticePayload) {
    const confirm = payload.confirmAction;
    const cancel = payload.cancelAction;
    return {
        onConfirm: confirm?.kind === 'copy' ? () => copyText(confirm.value) : undefined,
        onCancel: cancel?.kind === 'copy' ? () => copyText(cancel.value) : undefined,
    };
}
