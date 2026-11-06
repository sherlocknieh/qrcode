import { isLinkText, toOpenableUrl } from '@/services/linkText';
import type { NotifyResultItem } from '@/composables/useNotify';
import type { PopupNoticeAction, PopupNoticePayload } from '@/services/popupNotice';
import type { DecodeResult } from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { copyText } from '@/services/clipboard';

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
// 除确认外提供"框选扫描", 由 popup 或页面内兜底通知执行。
// 这里不给整屏扫描: 扫不中图片时用户要的是框住页面上那张图, 整屏再扫一遍大概率还是同样的结果
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
            extraButtonText: t('frameScanRetry'),
            showCloseButton: true,
        },
        extraAction: { kind: 'frameScan' },
    };
}

// 取图迟迟没有结果 (跨域/防盗链图片卡在下载上) 时换成这条提示:
// 继续干等没有意义, 就地给出"扫描屏幕"这个总能成功的出口
export const FETCH_TIMEOUT_MS = 5000;

export function fetchTimeoutNotice(): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'warning',
            title: t('fetchTimeout'),
            text: t('fetchTimeoutHint'),
            confirmButtonText: t('confirm'),
            extraButtonText: t('scanScreenRetry'),
            showCloseButton: true,
        },
        extraAction: { kind: 'screenScan' },
    };
}

// 取图 / 截图失败的提示文案:
// 浏览器原文 ("Failed to fetch" 之类) 只说明了底层机制, 用户看不出该做什么,
// 这里按常见错误类型换成可执行的建议; 认不出的错误保留原文, 便于反馈排查
export function describeImageError(error: unknown): string {
    const name = error instanceof DOMException ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);

    // 浏览器拒绝扩展访问 file:// 页面 (截图或注入内容脚本都被拦),
    // 不是图片本身的问题, 需要用户手动开启文件网址访问权限
    if (/cannot access contents of|must request permission to access/i.test(message)) {
        return t('errorHintFileAccess');
    }
    // 图片本身能显示, 但画布像素被浏览器禁止读取 (跨域图片、受保护资源)
    if (name === 'SecurityError' || /tainted|insecure|SecurityError/i.test(message)) {
        return t('errorHintCrossOrigin');
    }
    // 本地文件读取失败: 文件被移动/删除、无访问权限
    if (name === 'NotFoundError' || name === 'NotReadableError' || /read failed/i.test(message)) {
        return t('errorHintLocalFile');
    }
    // 数据解不成图片: 格式不支持、文件损坏, 或链接返回的其实不是图片
    if (name === 'EncodingError' || /decode|invalid image|unsupported image/i.test(message)) {
        return t('errorHintDecode');
    }
    // 取图请求失败: 断网、地址失效、被站点或 CORS 拦截
    if (/failed to fetch|network|load failed|net::err|request failed|http \d{3}/i.test(message)) {
        return t('errorHintNetwork');
    }
    if (/no usable dimensions/i.test(message)) return t('errorHintEmptyImage');
    if (error instanceof RangeError || /out of memory|allocation/i.test(message)) {
        return t('errorHintTooLarge');
    }
    return message;
}

// 扫描结果的通用通知构造: content / popup / capture 三个入口共用同一套分支
// (无结果重试 → 多码列表 → 单码链接/复制), 避免各写一遍文案与动作

// 重试方式决定按钮文案: 整屏重扫, 还是在刚截的视口图上自己框一块
function retryLabel(action?: PopupNoticeAction): string | undefined {
    if (action?.kind === 'screenScan') return t('scanScreenRetry');
    if (action?.kind === 'frameScan') return t('frameScanRetry');
    return undefined;
}

// 未扫描到任何码
function noResultNotice(retry?: PopupNoticeAction): PopupNoticePayload {
    return {
        options: {
            toast: false,
            icon: 'info',
            title: t('recognitionFailed'),
            text: t('recognitionFailedMsg'),
            extraButtonText: retryLabel(retry),
            showCloseButton: true,
        },
        extraAction: retry,
    };
}

// 批量结果的标题按实际码型区分:
// 混排时才能说"二维码和条形码", 纯二维码/纯条形码各自表述, 避免标题指向根本没扫到的类型
function multiResultTitle(results: DecodeResult[]): string {
    const hasQr = results.some((result) => result.kind === 'qr');
    const hasBarcode = results.some((result) => result.kind === 'barcode');
    if (hasQr && hasBarcode) return t('multiScanSuccess');
    return t(hasBarcode ? 'multiBarcodeScanSuccess' : 'multiQrcodeScanSuccess');
}

// 重复的码在画面上也要圈出来, 但通知里只列一次内容:
// 多码点选时同一内容可能在图上出现多份, 列表按码型 + 内容去重后逐条展示
function uniqueResults(results: DecodeResult[]): DecodeResult[] {
    const seen = new Set<string>();
    return results.filter((result) => {
        const key = `${result.kind}:${result.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// 去重真的发生时才提示, 让用户知道列表条数少于画面上的码数
function dedupNoticeText(results: DecodeResult[], unique: DecodeResult[]): string | undefined {
    return unique.length < results.length ? t('multiResultDeduped') : undefined;
}

// 多个结果: 逐条列出, 由用户分别打开/复制
function multiResultNotice(results: DecodeResult[]): PopupNoticePayload {
    const unique = uniqueResults(results);
    return {
        options: {
            toast: false,
            icon: 'success',
            title: multiResultTitle(results),
            text: dedupNoticeText(results, unique),
            items: toNoticeItems(unique),
            showCloseButton: true,
        },
    };
}

// 画面上已经用绿框标出每个码时先只给一条轻提示: 说明这次扫到多个码、每个都能点开;
// 内容默认收起, 点"显示全部"才摊开, 避免一上来就把同一批码在列表和绿框里各列一遍
export function multiFoundNotice(results: DecodeResult[]): PopupNoticePayload {
    const unique = uniqueResults(results);
    return {
        options: {
            toast: true,
            icon: 'success',
            title: multiResultTitle(results),
            text: dedupNoticeText(results, unique),
            items: toNoticeItems(unique),
            itemsCollapsed: true,
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
// retry: 未扫到码时提供的重试方式, 传 false 表示当前入口无法再试
// (独立扫描页里截图只会截到自己); 缺省为整屏重扫
export function resultNotice(
    results: DecodeResult[],
    options: { retry?: PopupNoticeAction | false } = {},
): PopupNoticePayload {
    if (!results.length) {
        return noResultNotice(options.retry === false ? undefined : options.retry ?? { kind: 'screenScan' });
    }
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
