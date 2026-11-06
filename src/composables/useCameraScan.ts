import { onBeforeUnmount, ref, type Ref } from 'vue';
import { decodeCameraFrame } from '@/services/qrScanner';

// 摄像头取图源: 只负责媒体流与逐帧轻量解码, 命中后交出一帧画面,
// 扫描与结果展示统一交给 ScanPanel 的 recognizeImage 流水线。
type CameraScanOptions = {
    video: Ref<HTMLVideoElement | null>;
    // 命中一帧后回调, 摄像头此时已停止; 返回 Promise 时会等扫描结束
    onFrame: (frame: ImageData) => unknown | Promise<unknown>;
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
    // 命中后定格的画面, 停止摄像头后仍能看到扫描到的内容
    const previewUrl = ref('');
    // 相机画面的宽高比, 交给取景框自适应; 0 表示还没拿到画面尺寸
    const aspectRatio = ref(0);
    // 是否镜像显示画面, 由摄像头朝向决定 (见 shouldMirror)
    const mirrored = ref(false);

    let stream: MediaStream | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let timer: number | undefined;
    let attempt = 0;
    let busy = false;
    let disposed = false;
    // 每次 start/stop 递增: 用户中途取消或重开时, 丢弃上一轮迟到的 getUserMedia 结果
    let session = 0;

    let boundVideo: HTMLVideoElement | null = null;

    function handleVideoResize() {
        if (boundVideo) syncAspectRatio(boundVideo);
    }

    function stopStream() {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        boundVideo?.removeEventListener('resize', handleVideoResize);
        boundVideo = null;
        if (options.video.value) options.video.value.srcObject = null;
    }

    function syncAspectRatio(video: HTMLVideoElement) {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
            aspectRatio.value = video.videoWidth / video.videoHeight;
        }
    }

    // 只有正对用户的画面才镜像: 手机扫码用的是后置摄像头,
    // 镜像后画面里的文字和二维码都是反的, 用户照着屏幕去找实物会对不上
    function shouldMirror(track?: MediaStreamTrack): boolean {
        const facing = track?.getSettings?.().facingMode;
        if (facing === 'environment') return false;
        if (facing === 'user') return true;
        // 未标注朝向的设备多半是桌面摄像头, 用指针类型兜底: 触屏设备按手机处理
        return !window.matchMedia?.('(pointer: coarse)').matches;
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

            // 命中即停: 定格画面并立刻关掉摄像头, 把这一帧交给统一扫描流程
            active.value = false;
            previewUrl.value = canvas?.toDataURL('image/jpeg', 0.85) ?? '';
            stopStream();
            await options.onFrame(frame);
        } catch {
            // 单帧解码失败不打断扫描, 下一帧继续
        } finally {
            busy = false;
            schedule();
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

    // 不指定尺寸时浏览器默认给 4:3 (常见 640x480), 与 16:9 取景框不匹配;
    // 这里用 ideal 请求 16:9, 设备不支持时浏览器会退回最接近的分辨率, 不会失败
    const videoConstraints: MediaTrackConstraints = {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 },
    };

    // 桌面浏览器没有后置摄像头, facingMode 失败时退回默认设备
    async function requestStream(): Promise<MediaStream> {
        try {
            return await navigator.mediaDevices.getUserMedia({
                video: videoConstraints,
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
            boundVideo = video;
            // 手机横竖屏切换后 videoWidth/Height 会变, 取景框跟着重算
            video.addEventListener('resize', handleVideoResize);
            mirrored.value = shouldMirror(media.getVideoTracks()[0]);
            syncAspectRatio(video);
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

    return { active, starting, previewUrl, aspectRatio, mirrored, start, stop, resume };
}
