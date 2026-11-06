<!-- Popup 页面, 有两个职责: 展示二维码/展示通知 -->

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  decodeAllFromImageData,
  getImageDataFromDataUrl,
  type DecodeResult,
} from '@/services/qrScanner';
import { t } from '@/services/i18n';
import { sendMessage, trySendMessage } from '@/services/messaging';
import {
  copyHandlers,
  describeImageError,
  errorNoticeWithScreenshot,
  FETCH_TIMEOUT_MS,
  fetchTimeoutNotice,
  multiFoundNotice,
  resultNotice,
  runNoticeAction,
} from '@/services/decodeResultNotice';
import { storageArea, storageAreaName, takeStoredString, takeStoredValue } from '@/services/storage';
import { measureImageRect } from '@/services/imageRect';
import { useNotify, notifyState } from '@/composables/useNotify';
import { usePopupNoticeHost } from '@/composables/usePopupNoticeHost';
import { useScanAnimation } from '@/composables/useScanAnimation';
import { useCodePicker } from '@/composables/useCodePicker';
import type { PopupNoticeRecord } from '@/services/popupNotice';
import NotifyHost from '@/components/NotifyHost.vue';
import QrCodePanel from '@/components/QrCodePanel.vue';
import ScanMarks from '@/components/ScanMarks.vue';

// 入口在挂载前读完存储的待展示通知: 首帧就要渲染它, 窗口才能直接按通知高度成型
const props = defineProps<{ pendingNotice?: PopupNoticeRecord }>();

const QR_TEXT_KEY = 'qrCodeText';
// SVG 等非 HTML 页面无法使用内容脚本弹窗, 由 background 把图片地址写入该键
const QR_IMAGE_KEY = 'qrImageUrl';
// 在 popup 自己的二维码上右键"扫描图片"时依次说下一句逗趣文案
const SCAN_SELF_EGG_KEYS = ['scanSelfEgg1', 'scanSelfEgg2', 'scanSelfEgg3'];
// 彩蛋气泡的文案与自动消失定时器
const eggText = ref('');
// 顺序轮播的下标: 每次右键往后挪一句, 说完再从第一句开始
let eggIndex = 0;
let eggTimer: number | undefined;


const { fire, close, showLoading } = useNotify();
// 接收内容脚本转发的通知并代为处理结果操作; 预读到的通知在挂载前就渲染出来
usePopupNoticeHost(props.pendingNotice);

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
    // 两个类分开标: popup-page 是整页打开 (要铺满视口), popup-surface 才是真正的弹窗
    if (window.innerHeight - contentHeight > 120) {
      document.documentElement.classList.add('popup-page');
    } else {
      document.documentElement.classList.add('popup-surface');
    }
  });
});


let scanning = false;
// 扫描期间隐藏二维码面板
const scanActive = ref(false);
// 扫描期间显示待扫描的图片: 窗口按这张图成型, 用户能看清扫的是哪一张,
// 扫描动画也播在它上面
const previewUrl = ref('');
const previewImg = ref<HTMLImageElement | null>(null);
const scanAnimation = useScanAnimation();

// 多码点选: 扫到多条结果时把预览图留在窗口里叠绿点, 点哪条才出哪条的通知,
// 与网页图片、扫描面板共用同一套绿点交互
const picking = ref(false);
const codePicker = useCodePicker({
  notifyResults: async (picked) => {
    await showResultNotice(picked);
    finishPickingIfDone();
  },
});
const marks = codePicker.marks;
const pickedFlags = codePicker.pickedFlags;
const pickMark = codePicker.pick;
const clearMarks = codePicker.clear;

// 收起扫描动画与预览图: 动画先淡出再取走图片, 免得图片先消失、光带还在飞
async function stopPreview() {
  await scanAnimation.stop();
  previewUrl.value = '';
}

// 点完最后一条绿点: 收起预览图, 没有二维码可展示时连空窗口一起关掉
function finishPickingIfDone() {
  if (!picking.value || codePicker.remaining.value > 0) return;
  picking.value = false;
  previewUrl.value = '';
  scanActive.value = false;
  if (!hasQrContent.value) window.close();
}
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

  // 取图提示与扫描分开: 网络取图（含后台代理/截屏兜底）不占用扫描动画的时间.
  // 卡在下载上 (跨域/防盗链) 超过 FETCH_TIMEOUT_MS 就换成建议截屏的通知:
  // 关掉通知即回到二维码面板继续等, 图片到手后照常扫描
  let fetchTimer: number | undefined;

  async function showFetchTimeout() {
    const response = await fire(fetchTimeoutNotice().options);
    if (response.dismiss !== 'extra') return;
    // 与扫描失败时的出口一致: 交给内容脚本重扫, 成功就把 popup 让出焦点
    const result = await trySendMessage('requestScreenScan');
    if (result?.success) window.close();
  }

  if (needsFetch) {
    showLoadingNotice(t('fetchingImage'), t('fetchingImageHint'));
    fetchTimer = window.setTimeout(() => { void showFetchTimeout(); }, FETCH_TIMEOUT_MS);
  }

  let results: DecodeResult[];
  // 解码图像的像素尺寸: 多码点选时绿点要按它把码的包围盒换算到预览图的实际显示区域
  let imageSize = { width: 0, height: 0 };
  try {
    // 图片一到就撤掉超时计时, 免得它把扫描预览顶成"改用扫描屏幕"
    const dataUrl = await getDataUrl().finally(() => window.clearTimeout(fetchTimer));
    const imageData = await getImageDataFromDataUrl(dataUrl);
    imageSize = { width: imageData.width, height: imageData.height };
    // 图片就绪后先把它显示出来再播扫描动画: 扩展商店这类只能由 popup 扫描的页面里,
    // 用户能看清扫的是哪张图, 窗口也从这一刻起按图片成型, 而不是先占着一个空通知
    close();
    previewUrl.value = dataUrl;
    await nextTick();
    // 等图片解码出尺寸后只扫图片本身 (遮罩压住图, 不会把整个弹窗都压暗)
    const image = previewImg.value;
    await image?.decode().catch(() => { });
    await scanAnimation.play({ rect: image ? measureImageRect(image) : undefined });
    // 大图解码会阻塞 UI: 先让动画画上屏, 再占用主线程解码
    await new Promise((resolve) => setTimeout(resolve, 50));
    results = await decodeAllFromImageData(imageData);
  } catch (error) {
    await stopPreview();
    // 扫描已经结束, 画面交给通知: 提前退出扫描态, 通知被关掉时才能立刻判断出
    // "没有二维码可展示" 并关窗, 而不是等整个扫描流程 return 后才置回
    scanActive.value = false;
    close();
    // 图片加载失败与其它入口共用同一条失败通知: toast 形态在 popup 里不渲染操作按钮,
    // 这里必须用带"框选扫描"的完整通知, 用户才能从读不出的图片换到框选
    const { options: failureOptions } = errorNoticeWithScreenshot(errorTitle, describeImageError(error));
    const response = await fire(failureOptions);
    if (response.dismiss === 'extra') {
      // 与本页其它失败出口一致交给当前页, 注入不了内容脚本的页面由后台截视口开可框选的截图页
      const result = await trySendMessage('requestFrameScan');
      if (result?.success) window.close();
    }
    // 流程结束后保留窗口, 由用户自行关闭
    return;
  }

  // 多条结果: 先弹一条"扫到多个码"的提示, 关掉后再把预览图留在窗口里叠绿点,
  // 点哪条才出哪条的通知; 有码定位不到时绿点会漏, 仍用列表通知把全部结果列出来
  const image = previewImg.value;
  const previewRect = image ? measureImageRect(image) : undefined;
  if (results.length > 1 && previewRect && results.every((result) => result.bounds)) {
    await scanAnimation.stop();
    // 提示与预览图不同时占位: 窗口小, 两者并排会把弹窗撑开
    await fire({ ...multiFoundNotice(results).options });
    // 预览图随提示收起后重新挂载, 绿点要按它这次的位置量
    await nextTick();
    const preview = previewImg.value;
    if (preview) await preview.decode().catch(() => { });
    await nextTick();
    const rect = (previewImg.value && measureImageRect(previewImg.value)) || previewRect;
    picking.value = true;
    codePicker.show(results, {
      rect,
      imageSize,
      scroll: { x: 0, y: 0 },
      viewportWidth: window.innerWidth,
      // popup 是独立窗口, 不随页面滚动
      followScroll: false,
    });
    return;
  }

  // 动画淡出、图片收起后再出结果通知, 两者不同时占位, 窗口只在这一步换一次高度
  await stopPreview();
  scanActive.value = false;
  await showResultNotice(results);
}

// 展示结果通知: 单条结果点确认时执行打开/复制
async function showResultNotice(results: DecodeResult[]) {
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
}

// 实现展开面板里的扫码入口: 扫描要在扩展页或页面浮层里完成,
// popup 失焦即关闭且会挡住页面浮层, 因此拿到后台成功回执后主动收起 popup;
// 失败时保留窗口, 让后台给出的错误通知还能被看到
async function startPanelScan(entry: 'screen' | 'camera') {
  const action = entry === 'screen' ? 'requestScreenScan' : 'openScanPanel';
  const response = await trySendMessage(action);
  if (response?.success) window.close();
}

async function startScan(imageUrl: string) {
  if (scanning) return;
  scanning = true;
  // 上一轮可能停在多码点选: 新一轮扫描前先撤掉残留的绿点与点选态
  codePicker.clear();
  picking.value = false;
  scanActive.value = true;
  prepareScanView();
  try {
    await scanLocalImage(imageUrl);
  } finally {
    // 扫描流程结束就退出扫描态: 否则关掉结果通知后 popup 既没有二维码也没有内容,
    // 空窗兜底会因为 scanActive 仍为 true 而不关闭窗口, 留下白窗
    scanning = false;
    // 多码点选期间保留预览图与窗口, 点完后由 finishPickingIfDone 收尾
    if (!picking.value) scanActive.value = false;
  }
}

// 在 popup 里面的二维码上右键"扫描图片":
// 扫自己刚生成的二维码本来就没有意义 (解出来就是地址栏/输入框里的文字),
// 因此不真的解码, 只在二维码上逗一句.
// 用面板内的气泡而不是通知: 通知会把弹窗窗口从二维码尺寸撑成通知尺寸,
// 收起时窗口要重排, 中间会白闪一下
function onRuntimeMessage(message: { action?: string }) {
  if (message?.action !== 'scanPopupQr') return;
  const key = SCAN_SELF_EGG_KEYS[eggIndex % SCAN_SELF_EGG_KEYS.length]!;
  eggIndex += 1;
  eggText.value = t(key);
  if (eggTimer !== undefined) window.clearTimeout(eggTimer);
  eggTimer = window.setTimeout(() => {
    eggTimer = undefined;
    eggText.value = '';
  }, 2600);
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
  browser.runtime.onMessage.addListener(onRuntimeMessage);
  const imageUrl = await takeStoredImageUrl();
  if (imageUrl) {
    startScan(imageUrl);
    return;
  }

  // 左键点击工具栏图标始终执行默认操作: 用当前页面地址预填输入框
  qrText.value = await resolveQrText();
});

// popup 是独立窗口, 通知结束后若没有任何内容会留下空白窗口;
// 只在展示过通知、且既无二维码也无扫描结果时才关闭.
// 关闭要落在通知还在画面的这一刻: 等它淡出结束后再关, 中间会露出一帧空窗口
// (弹窗窗口已经缩了、内容还没画上来), 看起来就是白闪一下
let hadNotice = false;
watch(
  () => notifyState.open,
  (open) => {
    if (open) {
      hadNotice = true;
      return;
    }
    if (!hadNotice) return;
    if (hasQrContent.value || scanActive.value || previewUrl.value) return;
    window.close();
  },
);

onBeforeUnmount(() => {
  browser.runtime.onMessage.removeListener(onRuntimeMessage);
  if (eggTimer !== undefined) window.clearTimeout(eggTimer);
});

</script>

<template>
  <!-- 二维码面板 -->
  <QrCodePanel
    v-show="!notifyState.open && !previewUrl"
    v-model="qrText"
    collapsible
    :flash-text="eggText"
    @scan="startPanelScan"
  />

  <!-- 待扫描的图片: 扫描在 popup 里进行时先把图片显示出来, 扫描动画也播在它上面;
       多码点选时点了绿点先让位给该条通知, 通知收起后再回来接着点 -->
  <div v-if="previewUrl && !notifyState.open" class="qr-scan-preview">
    <img ref="previewImg" :src="previewUrl" alt="" />
  </div>

  <!-- 多条结果时在预览图上叠绿点, 点哪条就展示哪条的通知 -->
  <ScanMarks v-if="!notifyState.open" :rects="marks" :picked="pickedFlags" @pick="pickMark" @dismiss="clearMarks" />

  <!-- 通知弹窗 -->
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
  /* 通知退场时要叠在面板上定位 (见下方 leave-active 规则) */
  position: relative;
}

/* 扫描期间的待扫描图片: 高度和二维码面板同一量级,
   窗口不会因为一张大图猛地撑开, 动画收起后切到结果通知也只有很小的落差 */
.qr-scan-preview {
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  align-items: center;
  max-width: 360px;
  padding: 16px;
}

.qr-scan-preview img {
  display: block;
  max-width: 320px;
  max-height: 220px;
  border-radius: 6px;
}

/* 通知退场时脱离文档流并铺满 #app: 被它顶掉的面板此时已经回到流里,
   两者叠着淡出, 而不是并排铺开把弹窗宽度撑大再缩回来 (那会闪一下).
   退场期间不拦截点击, 面板上的操作照常可用 */
#app > .qr-notify-root--embedded.qr-notify-fade-leave-active {
  position: absolute;
  inset: 0;
  width: auto;
  min-width: 0;
  pointer-events: none;
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

/* 抽屉动画期间文档会比弹窗窗口略高 (窗口改尺寸是异步的), 不裁掉火狐会闪出滚动条 */
html.popup-surface {
  overflow: hidden;
}
</style>
