import { notifyState } from '@/composables/useNotify';
import { sendMessage } from '@/services/messaging';

// 通知是否还显示在画面上: 页面内兜底通知看本地状态, 交给 popup 时问后台.
// 只读结果层点空白关闭前要先确认这一点: 通知开着时这一下往往是去关通知窗口
export async function isNoticeVisible(): Promise<boolean> {
    if (notifyState.open) return true;
    try {
        const response = await sendMessage<{ open?: boolean }>('popupNoticeOpen');
        return response.open === true;
    } catch {
        return false;
    }
}
