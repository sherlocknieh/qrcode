import { onBeforeUnmount, ref, type Ref } from 'vue';
import { decodeAllFromImageData, decodeCameraFrame, type DecodeResult } from '@/services/qrScanner';

// 摄像头取帧与连续识别: 只负责媒体流、取帧循环和结果回调,
// 提示与结果展示交给调用方, 与 useImageScan 的分工保持一致。
type CameraScanOptions = {
    video: Ref<HTMLVideoElement | null>;
    // 命中一帧后回调, 摄像头此时已停止; 返回 Promise 时会等结果通知展示结束
    onResults: (results: DecodeResult[]) => unknown | Promise<unknown>;
    // 请求摄像头失败 (权限/设备/占用) 时回调
    onError: (error: unknown) => void;
};

// 视频帧的扫描尺寸: 720 足以看清桌面距离下的二维码模块,
// 再大只会让每帧的灰度转换和 ZXing 解码变慢。
const FRAME_MAX_DIMENSION = 720;

// 帧间隔: 约 6 帧/秒, 既能及时响应, 又给解码和预览留出主线程。
const SCAN_INTERVAL_MS = 160;

export function useCameraScan(options: CameraScanOptions) {
    const active = ref(false);
    const starting = ref(false);
    // 命中后定格的画面, 停止摄像头后仍能看到识别到的内容
    const previewUrl = ref('');

    let stream: MediaStream | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let busy = false;
    let disposed = false;
    // 每次 start/stop 递增: 用户中途取消或重开时, 丢弃上一轮迟到的 getUserMedia 结果
    let session = 0;

    function stopStream() {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        if (options.video.value) options.video.value.srcObject = null;
    }

    // 停止扫描并关掉摄像头指示灯; 已定格的结果保留
    function stop() {
        session++;
        active.value = false;
        starting.value = false;
        if (timer !== undefined) {
            window.clearTimeout(timer);
            timer = undefined;
        }
        stopStream();
    }

    function schedule() {
        if (disposed || !active.value || timer !== undefined) return;
        timer = window.setTimeout(() => {
            timer = undefined;
            void tick();
        }, SCAN_INTERVAL_MS);
    }

    async function tick() {
        if (!active.value || busy || disposed) {
            schedule();
            return;
        }
        // 标签页在后台时不取帧, 但保持摄像头连接, 回到前台继续扫描
        if (document.hidden) {
            schedule();
            return;
        }
        const video = options.video.value;
        if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
            schedule();
            return;
        }

        busy = true;
        try {
            const frame = captureFrame(video);
            if (!frame) return;
            const hit = decodeCameraFrame(frame, attempt++);
            if (!hit.length || !active.value) return;

            // 命中即停: 定格画面并立刻关掉摄像头, 再展示结果
            active.value = false;
            previewUrl.value = canvas?.toDataURL('image/jpeg', 0.85) ?? '';
            stopStream();
            const results = await completeResults(frame, hit);
            await options.onResults(results);
        } catch {
            // 单帧解码失败不打断扫描, 下一帧继续
        } finally {
            busy = false;
            schedule();
        }
    }

    // 轻量扫描只确认"这一帧有码"; 再对同一帧跑一次完整识别, 补齐同画面的其它码
    async function completeResults(frame: ImageData, hit: DecodeResult[]): Promise<DecodeResult[]> {
        try {
            const all = await decodeAllFromImageData(frame);
            return all.length ? all : hit;
        } catch {
            return hit;
        }
    }

    function captureFrame(video: HTMLVideoElement): ImageData | null {
        const scale = Math.min(1, FRAME_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas ??= document.createElement('canvas');
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return null;
        context.drawImage(video, 0, 0, width, height);
        return context.getImageData(0, 0, width, height);
    }

    // 桌面浏览器没有后置摄像头, facingMode 失败时退回默认设备
    async function requestStream(): Promise<MediaStream> {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false,
            });
        } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'OverconstrainedError') throw error;
            return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
    }

    async function start() {
        if (starting.value || active.value) return;
        const token = ++session;
        starting.value = true;
        previewUrl.value = '';
        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                throw new Error('navigator.mediaDevices.getUserMedia is unavailable.');
            }
            const media = await requestStream();
            // 等待授权期间用户可能点了停止或切走, 迟到的流直接释放
            if (disposed || token !== session) {
                media.getTracks().forEach((track) => track.stop());
                return;
            }
            stream = media;
            const video = options.video.value;
            if (!video) throw new Error('Video element is not ready.');
            video.srcObject = media;
            await video.play();
            active.value = true;
            attempt = 0;
            schedule();
        } catch (error) {
            if (token !== session) return;
            stopStream();
            options.onError(error);
        } finally {
            if (token === session) starting.value = false;
        }
    }

    // 结果通知结束后由用户决定是否继续: 自动恢复会让同一个码反复弹窗
    const resume = () => start();

    onBeforeUnmount(() => {
        disposed = true;
        stop();
    });

    return { active, starting, previewUrl, start, stop, resume };
}
