import { nextTick, reactive } from 'vue';

export type NotifyIcon = 'info' | 'success' | 'error' | 'warning';
export type NotifyDismissReason = 'cancel' | 'close' | 'extra' | 'replaced';

// 批量识别结果条目: 保持可序列化, 以便内容脚本通过 popup 通知展示
export interface NotifyResultItem {
    text: string;
    kind: 'qr' | 'barcode';
}

export interface NotifyOptions {
    toast?: boolean;
    icon?: NotifyIcon;
    title?: string;
    text?: string;
    // 多结果列表; 设置后通知主体改为逐条展示
    items?: NotifyResultItem[];
    showCloseButton?: boolean;
    showCancelButton?: boolean;
    confirmButtonText?: string;
    cancelButtonText?: string;
    // 额外操作按钮, 点击后以 dismiss: 'extra' 结束通知
    extraButtonText?: string;
    // 自定义按钮行为: 返回后通知保持打开; 返回 true 时按钮短暂显示已复制
    onConfirm?: NotifyActionHandler;
    onCancel?: NotifyActionHandler;
    didOpen?: () => void;
}

export type NotifyActionHandler = () => void | boolean | Promise<void | boolean>;

export interface NotifyResult {
    isConfirmed: boolean;
    isDismissed: boolean;
    dismiss?: NotifyDismissReason;
}

interface NotifyState {
    open: boolean;
    options: NotifyOptions;
    loading: boolean;
}

// 通知是全局单例: 同一时间只显示一个, 再次触发会先结束上一条
const state = reactive<NotifyState>({
    open: false,
    options: {},
    loading: false,
});

let resolveCurrent: ((result: NotifyResult) => void) | null = null;

function finish(result: NotifyResult) {
    const resolve = resolveCurrent;
    resolveCurrent = null;
    state.open = false;
    state.loading = false;
    resolve?.(result);
}

function settlePrevious() {
    if (!resolveCurrent) return;
    finish({ isConfirmed: false, isDismissed: true, dismiss: 'replaced' });
}

function fire(options: NotifyOptions = {}): Promise<NotifyResult> {
    settlePrevious();

    const promise = new Promise<NotifyResult>((resolve) => {
        resolveCurrent = resolve;
    });

    state.options = { ...options };
    state.loading = false;
    state.open = true;

    void nextTick(() => {
        if (state.open) options.didOpen?.();
    });

    return promise;
}

const close = () => finish({ isConfirmed: false, isDismissed: true, dismiss: 'close' });
const cancel = () => finish({ isConfirmed: false, isDismissed: true, dismiss: 'cancel' });
const extra = () => finish({ isConfirmed: false, isDismissed: true, dismiss: 'extra' });
const confirm = () => finish({ isConfirmed: true, isDismissed: false });
const showLoading = () => {
    if (state.open) state.loading = true;
};

export function useNotify() {
    return { fire, close, cancel, confirm, showLoading };
}

// 供通知宿主组件读取状态与回调
export const notifyState = state;
export {
    cancel as cancelNotify,
    close as closeNotify,
    confirm as confirmNotify,
    extra as extraNotify,
};
