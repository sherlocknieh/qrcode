import { isLinkText, toOpenableUrl } from '@/services/linkText';
import type { NotifyResultItem } from '@/composables/useNotify';
import type { PopupNoticeAction, PopupNoticePayload } from '@/services/popupNotice';
import type { DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { copyText } from '@/services/clipboard';

// 识别结果的通用通知构造: content / popup / capture 三个入口共用同一套分支
// (无结果重试 → 多码列表 → 单码链接/复制), 避免各写一遍文案与动作

// 未识别到任何码: 提供"重新截图"出口
function noResultNotice(): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'warning',
            title: t('recognitionFailed'),
            text: t('recognitionFailedMsg'),
            confirmButtonText: t('confirm'),
            extraButtonText: t('screenshotRetry'),
            showCloseButton: true,
        },
        extraAction: { kind: 'screenshot' },
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

// 按结果数量选择对应的通知
export function resultNotice(results: DecodeResult[]): PopupNoticePayload {
    if (!results.length) return noResultNotice();
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
