<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  decodeAllFromImageData,
  getImageDataFromDataUrl,
  type DecodeResult,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage, trySendMessage } from '@/services/messaging';
import { copyHandlers, describeImageError, resultNotice, runNoticeAction } from '@/services/decodeResultNotice';
import { storageArea, storageAreaName, takeStoredString, takeStoredValue } from '@/services/storage';
import { useNotify, notifyState } from '@/composables/useNotify';
import { usePopupNoticeHost } from '@/composables/usePopupNoticeHost';
import NotifyHost from '@/components/NotifyHost.vue';
import QrCodePanel from '@/components/QrCodePanel.vue';

const QR_TEXT_KEY = 'qrCodeText';
// SVG 等非 HTML 页面无法使用内容脚本弹窗, 由 background 把图片地址写入该键
const QR_IMAGE_KEY = 'qrImageUrl';


const { fire, close, showLoading } = useNotify();
// 接收内容脚本转发的通知并代为处理结果操作
usePopupNoticeHost();

// 修复手机上标题显示为 __MSG_appShortName__ 的问题:
// 手机浏览器把 popup 页面当普通标签页打开, 标题会直接照搬源码里的占位符
// 改为运行时设置标题, 由浏览器按 _locales 本地化标题
document.title = t('appShortName');
// 修复手机上二维码竖直不居中的问题:
// 手机浏览器把 popup 页面当普通标签页打开, 铺满整屏, 内容却按弹窗高度顶对齐
// 原先靠 tabs.getCurrent() 识别整页打开, 但 Firefox Android 取不到当前页, 类加不上
// 改为比较视口与内容高度: 桌面弹窗高度贴合内容, 差值约 0; 整页打开时视口比内容高出一大截.
// 必须量 #app 的实际高度, body.scrollHeight 在内容不足一屏时会被抬到视口高度, 差值永远是 0
onMounted(() => {
  requestAnimationFrame(() => {
    const contentHeight = document.querySelector('#app')?.getBoundingClientRect().height ?? 0;
    if (window.innerHeight - contentHeight > 120) {
      document.documentElement.classList.add('popup-page');
    }
  });
});


let scanning = false;
// 扫描期间隐藏二维码面板
const scanActive = ref(false);
// 输入框内容即二维码内容, 打开时预填当前页地址
const qrText = ref('');
const hasQrContent = computed(() => qrText.value.length > 0);

// 图片地址可能由旧版本以 { url } 对象形式写入, 这里统一取出地址
function normalizeStoredImage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const url = (value as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return '';
}

// 读取右键菜单或扫描页写入的临时图片地址, 读取后立即清除
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


// 扫描图片并展示结果, 交互与内容脚本保持一致
async function decodeAndShow(
  getDataUrl: () => Promise<string>,
  errorTitle: string,
  // 已经是 data URL (截图交接) 时没有下载过程, 不必提示"正在获取图片"
  needsFetch = true,
) {
  const showLoadingNotice = (title: string, text?: string) => fire({
    toast: true,
    icon: 'info',
    title,
    text,
    didOpen: () => showLoading(),
    showCloseButton: true,
  });

  // 取图与扫描分开提示: 网络取图（含后台代理/截屏兜底）不占用"正在扫描"的等待时间
  if (needsFetch) showLoadingNotice(t('fetchingImage'), t('fetchingImageHint'));

  let imageData: ImageData;
  let results: DecodeResult[];
  try {
    imageData = await getImageDataFromDataUrl(await getDataUrl());
    showLoadingNotice(t('decodingQR'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    results = await decodeAllFromImageData(imageData);
  } catch (error) {
    close();
    await fire({
      toast: true,
      icon: 'error',
      title: errorTitle,
      text: describeImageError(error),
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
    // 未扫描到码时提供"改用扫描屏幕": popup 不是页面浮层, 交给内容脚本重新截屏;
    // 内容脚本不可用 (如 PDF 阅读器) 时, 由后台截取视口后在新标签页中扫描
    const result = await trySendMessage('requestScreenScan');
    if (result?.success) window.close();
    return;
  }

  const single = results.length === 1 ? results[0]! : undefined;
  if (single && response.isConfirmed) runNoticeAction(payload.confirmAction);
}

function scanLocalImage(imageUrl: string) {
  return decodeAndShow(
    () => loadImageDataUrl(imageUrl),
    t('imageFetchFailed'),
    !imageUrl.startsWith('data:'),
  );
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

// 实现展开面板里的扫码入口: 扫描要在网页浮层或独立扫描页里完成,
// popup 失焦即关闭且会挡住页面浮层, 因此拿到后台成功回执后主动收起 popup;
// 失败时保留窗口, 让后台给出的错误通知还能被看到
async function startPanelScan(entry: 'image' | 'screen' | 'camera') {
  const action = entry === 'image'
    ? 'openImageScan'
    : entry === 'screen'
      ? 'requestScreenScan'
      : 'openCameraScan';
  const response = await trySendMessage(action);
  if (response?.success) window.close();
}

async function startScan(imageUrl: string) {
  if (scanning) return;
  scanning = true;
  scanActive.value = true;
  prepareScanView();
  try {
    await scanLocalImage(imageUrl);
  } finally {
    // 扫描流程结束就退出扫描态: 否则关掉结果通知后 popup 既没有二维码也没有内容,
    // 空窗兜底会因为 scanActive 仍为 true 而不关闭窗口, 留下白窗
    scanning = false;
    scanActive.value = false;
  }
}

// background 在用户手势中同步打开 popup, 临时文本可能稍后才写入, 需监听变更刷新
function onStorageChanged(
  changes: Record<string, { newValue?: unknown }>,
  areaName: string,
) {
  if (areaName !== storageAreaName()) return;
  // 非 HTML 页面或扫描页传入的图片地址优先处理
  const imageUrl = normalizeStoredImage(changes[QR_IMAGE_KEY]?.newValue);
  if (imageUrl) {
    startScan(imageUrl);
    void storageArea().remove(QR_IMAGE_KEY);
    return;
  }
  const value = changes[QR_TEXT_KEY]?.newValue;
  if (typeof value === 'string' && value) {
    qrText.value = value;
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

  // 左键点击工具栏图标始终执行默认操作: 用当前页面地址预填输入框
  qrText.value = await resolveQrText();
});

// popup 是独立窗口, 通知结束后若没有任何内容会留下空白窗口;
// 只在展示过通知、且既无二维码也无扫描结果时才关闭
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

</script>

<template>
  <QrCodePanel
    v-if="!notifyState.open && !scanActive"
    v-model="qrText"
    collapsible
    @scan="startPanelScan"
  />
  <NotifyHost embedded />
</template>

<style>
body {
  margin: 0; /* 去掉默认的 margin */
}

#app {
  /* 使用 Flexbox 布局 */
  display: flex;
  justify-content: center; /* 水平居中 */
  align-items: center;     /* 垂直居中 */
}

/* 修复手机上二维码不居中的问题:
   手机浏览器把 popup 页面当普通标签页打开, 需要铺满视口才能居中;
   弹窗里设 100vh 会让浏览器放大窗口, 收起输入框时窗口收不回去,
   所以只在标签页场景生效 */
html.popup-page #app {
  min-height: 100vh;
  /* 手机地址栏会收起/展开, 用 dvh 按当前可见高度居中, 免得被算进的工具栏顶偏 */
  min-height: 100dvh;
}
</style>
