---
description: "扫描与解码层的硬约束：ZXing 导入方式、一维码相邻行确认、降采样重扫、bounds 换算回原图、取图代理与提示时序。Use when: 改 qrScanner.ts / recognize.ts，或排查识别不出、位置标记偏移、大图卡顿。"
applyTo:
  - "src/services/qrScanner.ts"
  - "src/services/recognize.ts"
  - "src/entrypoints/content/App.vue"
---

# 扫描核心

- ZXing 用深路径导入（`@zxing/library/esm/core/...`），别改成包根导入。
- 摄像头逐帧只走 `decodeCameraFrame`；一维码命中必须过 `isOneDResultConfirmed` 核对相邻行——文字行也能凑出校验位合法的条码。
- 二维码整图与码面都失败时，把整图缩到 `QR_DOWNSCALE_DIMENSION` 再扫一遍（模块过大时定位点会漏检），命中坐标靠 `Candidate.scale` 换回原图。

# 位置标记的坐标换算

`bounds` 在解码所用图像的坐标系：裁剪候选靠 `offsetX/Y` 平移回原图，缩放 / 旋转靠 `BoundsMapper`，其余由 `toRect` 夹紧。

- 换算回原图之后的**补高与夹紧一律按原图尺寸**：超过 `BARCODE_SCAN_DIMENSION` 的截图会先被缩小，按候选图高度夹会把原图的 y 压到候选图高度上，条形码标记塌成一条线并跑位。
- 一维码定位点只到扫描行，条高方向是包围盒短边，由 `measureBarcodeBounds` 在原图上按条空剖面找连续带、再逐行解码确认；别退回按宽度比例估算（UPC 条高约等于宽的一半，估算只补了宽度的 8%）。
- 条空排列方向上定位点在起始 / 终止图案中心（UPC/EAN 是定界符中间的空隙，Code 128 是起始符中心），直接当边缘会把最外两根黑条切在框外，由 `measureBarEdges` 沿该方向走到静区取最外黑像素。

# 取图与提示

- 跨域 / 防盗链：`fetchViaProxy` 始终传。同源也可能 302 到 CDN 被 Chrome 判 canvas 污染，`loadImageDataFromUrl` 捕获污染错误后自动改走后台代理，这层兜底不能删。
- 提示分两段，动画在取图之后：取图慢于 150ms 才提示「正在获取图片」，超过 5s 换成建议扫描屏幕，图片之后仍继续扫。取图提示也走 popup，`notifyFetching` 返回收起函数，图片到手或超时提示接管时由 `recognizeImage` 收掉并让 popup 关窗。本地图与截图不需要这段提示。
- 大图解码阻塞 UI：先等动画首帧，再 `setTimeout(50)` 后解码。
