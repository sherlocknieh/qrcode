// wxt.config.ts
import { defineConfig } from 'wxt';
import { resolve } from 'node:path';

// dev 时每个浏览器用独立 profile 和调试端口, 多个浏览器才能同时运行
const devBrowser = process.env.WXT_DEV_BROWSER ?? 'chrome';
const cdpPort = process.env.WXT_DEV_CDP_PORT ?? '';

const binaries: Record<string, string> = {};
if (process.env.WXT_DEV_CHROME_BINARY) binaries.chrome = process.env.WXT_DEV_CHROME_BINARY;
if (process.env.WXT_DEV_EDGE_BINARY) binaries.edge = process.env.WXT_DEV_EDGE_BINARY;
if (process.env.WXT_DEV_FIREFOX_BINARY) binaries.firefox = process.env.WXT_DEV_FIREFOX_BINARY;

// 确保 dev profile 目录存在
import { mkdirSync } from 'node:fs';
mkdirSync(`.wxt/dev-profile/${devBrowser}`, { recursive: true });
mkdirSync('.wxt/dev-profile/firefox', { recursive: true });

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'], // 使用 Vue 模块
  srcDir: 'src',                    // 自定义源码目录
  webExt: {
    keepProfileChanges: true,       // 记忆浏览器配置变更, 防止每次调试都打开全新无配置的浏览器
    chromiumProfile: resolve(`.wxt/dev-profile/${devBrowser}`), // 调试时 Chromium 配置文件路径(按浏览器隔离)
    firefoxProfile: resolve('.wxt/dev-profile/firefox'), // 调试时 Firefox 配置文件路径
    chromiumArgs: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [], // 暴露调试端口, 供 .dev/pin-dev-extension.mjs 自动固定工具栏图标
    binaries: Object.keys(binaries).length > 0 ? binaries : undefined, // 由 .dev/dev.mjs 探测后传入
    // 调试时自动打开的页面
    startUrls: [
      'about:newtab',
      'https://inftab.com/',
      'https://en.wikipedia.org/wiki/QR_code',
      'https://en.wikipedia.org/wiki/Barcode',
      'https://www.deepseek.com/images/app-qrcode.png',
      'https://pdfobject.com/pdf/sample.pdf',
      'https://app.trakt.tv/favicon.svg',
    ],
  },
  manifest: {
    name: '__MSG_appName__',
    description: '__MSG_appDescription__',
    default_locale: 'en',
    author: 'sherlocknieh@gmail.com' as unknown as { email: string },
    homepage_url: 'https://github.com/sherlocknieh/qrcode',
    host_permissions: ['file:///*'], // 允许访问本地文件
    permissions: [
      'contextMenus',  // 右键菜单权限
      'storage',       // 本地存储权限
      'tabs',          // 所有标签元数据权限
      'activeTab',     // 前台标签页内容权限
      'clipboardWrite',// 复制截图到剪贴板
      'clipboardRead', // 读取剪贴板中的图片识别二维码
    ],
    icons: {
      16: 'icon/16.png',   // 工具栏,右键菜单,标签栏图标
      32: 'icon/32.png',   // Firefox 工具栏和扩展管理页面
      48: 'icon/48.png',   // Chrome 扩展管理页面
      128: 'icon/128.png', // 扩展商店页面
    },
    // Firefox 上传要求填写的项目
    browser_specific_settings: {
      gecko: {
        id: "qrcode@sherlocknieh.github.io",
        data_collection_permissions:{
          required: ['none']
        }
      },
    },
    // Firefox 地址栏按钮
    page_action: {
      default_icon: {
        19: 'icon/19.png',
        38: 'icon/38.png',
      },
      default_title: 'QRCode',
      default_popup: '/popup.html',
    },
  },
});