# 商店宣传图块

用于 Chrome Web Store / Edge 扩展商店的商品页宣传图，尺寸与格式符合商店要求（24 位 PNG，无 alpha 通道）。

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `small-tile-440x280.png` | 440×280 | 小型宣传图块（分类页 / 搜索结果） |
| `marquee-1400x560.png` | 1400×560 | 顶部宣传图块（商品页横幅） |

## 重新生成

源文件是同目录下的 HTML（固定宽高 + CSS 精确排版，字体用系统 Noto Sans CJK SC），用无头 Chrome 按视口原尺寸截图即可，不需要设计软件：

```bash
# 小型宣传图块
google-chrome --headless=new --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=440,280 \
  --virtual-time-budget=3000 --default-background-color=FFFFFFFF \
  --screenshot=small-tile-440x280.png \
  "file://$PWD/tile-small.html"

# 顶部宣传图块
google-chrome --headless=new --no-sandbox --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=1400,560 \
  --virtual-time-budget=3000 --default-background-color=FFFFFFFF \
  --screenshot=marquee-1400x560.png \
  "file://$PWD/tile-marquee.html"
```

`--default-background-color=FFFFFFFF` 用来保证整张图不透明；改完文字建议再用 `file` 或图像工具确认输出是 `8-bit/color RGB`。

## 素材

- `assets/icon128.png`：扩展图标（取自 `public/icon/128.png`）
- `assets/qr-main.png`、`assets/qr-page.png`：`qrcode` 库生成的真实二维码（EC=M，含 2 模块静区），可被正常扫出
