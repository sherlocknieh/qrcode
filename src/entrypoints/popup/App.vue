<script lang="ts" setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import qrcode from 'qrcode-generator';
import {
  decodeAllFromImageData,
  getImageDataFromDataUrl,
  type DecodeResult,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage, trySendMessage } from '@/services/messaging';
import { copyHandlers, resultNotice, runNoticeAction } from '@/services/decodeResultNotice';
import { storageArea, storageAreaName, takeStoredString, takeStoredValue } from '@/services/storage';
import { useNotify, notifyState } from '@/composables/useNotify';
import { usePopupNoticeHost } from '@/composables/usePopupNoticeHost';
import NotifyHost from '@/components/NotifyHost.vue';

// 设置 qrcode 库使用 UTF-8 编码, 避免汉字乱码问题
qrcode.stringToBytes = (s: string) => Array.from(new TextEncoder().encode(s));

const QR_TEXT_KEY = 'qrCodeText';
// SVG 等非 HTML 页面无法使用内容脚本弹窗, 由 background 把图片地址写入该键
const QR_IMAGE_KEY = 'qrImageUrl';


const { fire, close, showLoading } = useNotify();
// 接收内容脚本转发的通知并代为处理结果操作
usePopupNoticeHost();


let scanning = false;
// 扫描期间隐藏二维码占位
const scanActive = ref(false);
// 生成二维码后才显示占位, 避免 popup 打开瞬间先闪一下二维码区域
const hasQrContent = ref(false);

// 图片地址可能由旧版本以 { url } 对象形式写入, 这里统一取出地址
function normalizeStoredImage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const url = (value as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return '';
}

// 读取右键菜单或识别页写入的临时图片地址, 读取后立即清除
async function takeStoredImageUrl(): Promise<string> {
  return normalizeStoredImage(await takeStoredValue(QR_IMAGE_KEY));
}

// 读取右键菜单写入的临时文本, 读取后立即清除, 避免污染下次打开
const takeStoredText = () => takeStoredString(QR_TEXT_KEY);

// 优先 URL hash(新标签页兜底), 其次临时存储, 最后当前标签页 URL
async function resolveQrText(): Promise<string> {
  const storedText = await takeStoredText();
  const hashText = new URLSearchParams(location.hash.slice(1)).get('text') ?? '';
  if (hashText) return hashText;
  if (storedText) return storedText;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? '';
}

// 读取图片并转换为 Data URL: 优先直接请求(右键菜单已通过 activeTab 授权当前站点),
// 失败时再交给 background 代理, 以兼容不允许扩展直接访问的地址。
async function fetchAsDataUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await blobToDataUrl(await response.blob());
  } catch {
    return fetchViaBackground(url);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Read failed.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchViaBackground(url: string): Promise<string> {
  const response = await sendMessage<{ dataUrl: string }>('fetchImage', { url });
  return response.dataUrl;
}


// 识别图片并展示结果, 交互与内容脚本保持一致
async function decodeAndShow(getDataUrl: () => Promise<string>, errorTitle: string) {
  fire({
    toast: true,
    icon: 'info',
    title: t('decodingQR'),
    didOpen: () => showLoading(),
    showCloseButton: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  let results: DecodeResult[];
  try {
    const imageData = await getImageDataFromDataUrl(await getDataUrl());
    results = await decodeAllFromImageData(imageData);
  } catch (error) {
    close();
    await fire({
      toast: true,
      icon: 'error',
      title: errorTitle,
      text: error instanceof Error ? error.message : String(error),
      showCloseButton: true,
    });
    // 流程结束后保留窗口, 由用户自行关闭
    return;
  }

  close();
  const payload = resultNotice(results);
  // 复制按钮不结束通知: 复制成功后按钮就地显示已复制
  const response = await fire({ ...payload.options, ...copyHandlers(payload) });

  if (response.dismiss === 'replaced') return;

  if (response.dismiss === 'extra') {
    // 未识别到码时提供"重新截图": popup 不是页面浮层, 交给内容脚本在页面内框选;
    // 内容脚本不可用 (如 PDF 阅读器) 时, 由后台截取视口后在新标签页中框选
    const result = await trySendMessage('requestScreenshot');
    if (result?.success) window.close();
    return;
  }

  const single = results.length === 1 ? results[0]! : undefined;
  if (single && response.isConfirmed) runNoticeAction(payload.confirmAction);
}

function scanImage(imageUrl: string) {
  return decodeAndShow(() => loadImageDataUrl(imageUrl), t('imageFetchFailed'));
}

// Firefox 中扩展页面和后台脚本都无法 fetch file: 地址，
// 本地图片读取失败时退回截取当前标签页(图片文档会完整显示在视口中)。
async function loadImageDataUrl(imageUrl: string): Promise<string> {
  try {
    return await fetchAsDataUrl(imageUrl);
  } catch (error) {
    if (!imageUrl.startsWith('file:')) throw error;
    return captureVisibleTab();
  }
}

// 本地图片无法直接读取时, 截取当前标签页可见区域
async function captureVisibleTab(): Promise<string> {
  const response = await sendMessage<{ dataUrl: string }>('captureVisibleTab');
  return response.dataUrl;
}

function prepareScanView() {
  // 扫描结果弹窗需要更宽的展示空间
  document.documentElement.style.minWidth = '360px';
  if (document.body) document.body.style.minHeight = '220px';
}

async function startScan(imageUrl: string) {
  if (scanning) return;
  scanning = true;
  scanActive.value = true;
  prepareScanView();
  try {
    await scanImage(imageUrl);
  } finally {
    // 识别流程结束就退出扫描态: 否则关掉结果通知后 popup 既没有二维码也没有内容,
    // 空窗兜底会因为 scanActive 仍为 true 而不关闭窗口, 留下白窗
    scanning = false;
    scanActive.value = false;
  }
}

let currentText = '';

// 避免重复渲染相同内容
function render(text: string) {
  if (!text || text === currentText) return;
  currentText = text;
  hasQrContent.value = true;
  // 容器由 hasQrContent 控制, 需等渲染完成后再写入二维码
  void nextTick(() => generateQRCode(text));
}

// background 在用户手势中同步打开 popup, 临时文本可能稍后才写入, 需监听变更刷新
function onStorageChanged(
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) {
  if (areaName !== storageAreaName()) return;
  // 非 HTML 页面或识别页传入的图片地址优先处理
  const imageUrl = normalizeStoredImage(changes[QR_IMAGE_KEY]?.newValue);
  if (imageUrl) {
    startScan(imageUrl);
    void storageArea().remove(QR_IMAGE_KEY);
    return;
  }
  const value = changes[QR_TEXT_KEY]?.newValue;
  if (typeof value === 'string' && value) {
    render(value);
    void storageArea().remove(QR_TEXT_KEY);
  }
}

// Popup 挂载后开始工作
onMounted(async () => {
  // 先监听, 再解析, 以覆盖 background 稍后写入的竞态
  browser.storage.onChanged.addListener(onStorageChanged);
  const imageUrl = await takeStoredImageUrl();
  if (imageUrl) {
    startScan(imageUrl);
    return;
  }

  // 左键点击工具栏图标始终执行默认操作: 生成当前页面地址的二维码
  render(await resolveQrText());
});

// popup 是独立窗口, 通知结束后若没有任何内容会留下空白窗口;
// 只在展示过通知、且既无二维码也无识别结果时才关闭
let hadNotice = false;
let emptyTimer: number | undefined;
watch(
  () => notifyState.open,
  (open) => {
    if (open) {
      hadNotice = true;
      if (emptyTimer !== undefined) {
        window.clearTimeout(emptyTimer);
        emptyTimer = undefined;
      }
      return;
    }
    if (!hadNotice) return;
    if (emptyTimer !== undefined) window.clearTimeout(emptyTimer);
    emptyTimer = window.setTimeout(() => {
      emptyTimer = undefined;
      if (notifyState.open || hasQrContent.value || scanActive.value) return;
      window.close();
    }, 320);
  },
);

onBeforeUnmount(() => {
  if (emptyTimer !== undefined) {
    window.clearTimeout(emptyTimer);
    emptyTimer = undefined;
  }
});


// 二维码生成函数
function generateQRCode(text: string) {

  const container = document.getElementById('qrcode-container');
  if (!container) return;
  container.replaceChildren();  // 清空容器

  try {
    // 使用 qrcode 库生成二维码
    const qr = qrcode(0, 'M'); // 二维码大小:自动, 容错级别:中等
    qr.addData(text);          // 传入原数据
    qr.make();                 // 生成二维码

    // 生成 PNG 图片
    const moduleCount = qr.getModuleCount();    // 获取二维码矩阵尺寸
    const cellSize = 8;                         // 每个点块的像素大小
    const margin = cellSize * 2;                // 设置白边宽度
    const totalSize = (moduleCount * cellSize) + (margin * 2); // 最终图片尺寸

    // 创建 Canvas 用来生成 PNG
    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;

    // 获取 2D 绘图上下文
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('无法获取Canvas 2D上下文');
    };

    // 绘制白色背景
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalSize, totalSize);

    // 绘制黑色色块
    ctx.fillStyle = '#000000';
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) {
          const x = margin + col * cellSize;
          const y = margin + row * cellSize;
          ctx.fillRect(x, y, cellSize, cellSize);
        }
      }
    }

    // 生成 PNG 格式的数据链接
    const dataURL = canvas.toDataURL('image/png');

    // 创建 img 元素显示二维码
    const img = document.createElement('img');
    img.src = dataURL;                        // PNG格式的base64数据
    img.style.display = 'block';              // 去除图片下方空白缝隙
    img.style.width = '100%';                 // 自适应容器宽度
    img.style.imageRendering = 'pixelated';   // 保持像素清晰
    img.title = text;                         // 鼠标悬停显示原始文本
    img.alt = '二维码加载失败';               // 加载失败时的替代文本
    container.appendChild(img);

  } catch (error) {
    const title = document.createElement('div');
    title.style.color = 'red';
    title.textContent = '二维码生成失败:';
    const detail = document.createElement('div');
    detail.textContent = String(error);
    container.replaceChildren(title, detail);
  }
}
</script>

<template>
  <div
    v-if="hasQrContent && !notifyState.open && !scanActive"
    id="qrcode-container"
    class="bg-slate-50 border border-slate-200 rounded-lg shadow-sm"
  ></div>
  <NotifyHost embedded />
</template>

<style>
body {
  margin: 0; /* 去掉默认的 margin */
}

#app {
  /* 使用 Flexbox 布局 */
  display: flex;
  min-height: 100vh;       /* 占满视口高度 */
  justify-content: center; /* 水平居中 */
  align-items: center;     /* 垂直居中 */
}
</style>

<style scoped>
#qrcode-container {
  /* 固定长宽 */
  width: 220px;
  height: 220px;
  /* 内容居中 */
  display: flex;
  justify-content: center;
  align-items: center;
  /* 垂直排列 */
  flex-direction: column; 
}
</style>