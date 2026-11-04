// wxt.config.ts
import { defineConfig } from 'wxt';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// dev 时每个浏览器用独立 profile 和调试端口, 多个浏览器才能同时运行
const devBrowser = process.env.WXT_DEV_BROWSER ?? 'chrome';
const cdpPort = process.env.WXT_DEV_CDP_PORT ?? '';
// 可执行文件沿用用户环境变量; .dev/dev.mjs 探测到路径时也写进同名变量
const BINARY_ENV: Record<string, string> = { chrome: 'CHROME_BINARY', edge: 'EDGE_BINARY', firefox: 'FIREFOX_BINARY' };
const binary = process.env[BINARY_ENV[devBrowser] ?? ''];

const chromiumProfile = resolve(`.wxt/dev-profile/${devBrowser}`);
const firefoxProfile = resolve('.wxt/dev-profile/firefox');

// 确保 dev profile 目录存在
for (const profile of new Set([chromiumProfile, firefoxProfile])) {
  mkdirSync(profile, { recursive: true });
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'], // 使用 Vue 模块
  srcDir: 'src',                    // 自定义源码目录
  // dev server 端口由 .dev/dev.mjs 按浏览器固定传入 (chrome 3000 / edge 3001 / firefox 3002)。
  // 这里开启 strictPort: 端口被占用时直接报错, 不要静默换端口 —— 换端口后已加载的 dev 扩展
  // 仍连旧端口, 热更新/重载会失效; 同一浏览器的两个 dev 实例还会争写同一个 .output 目录。
  dev: {
    server: {
      strictPort: true,
    },
  },
  webExt: {
    keepProfileChanges: true,       // 记忆浏览器配置变更, 防止每次调试都打开全新无配置的浏览器
    chromiumProfile,                // 调试时 Chromium 配置文件路径(按浏览器隔离)
    firefoxProfile,                 // 调试时 Firefox 配置文件路径
    chromiumArgs: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [], // 暴露调试端口, 供 .dev/pin-dev-extension.mjs 自动固定工具栏图标
    binaries: binary ? { [devBrowser]: binary } : undefined, // 由 .dev/dev.mjs 探测后传入
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
    ],
    icons: {
      16: 'icon/16.png',   // 工具栏,右键菜单,标签栏图标
      32: 'icon/32.png',   // Firefox 工具栏和扩展管理页面
      48: 'icon/48.png',   // Chrome 扩展管理页面
      128: 'icon/128.png', // 扩展商店页面
    },
    // 工具栏提示文案: popup 的 <title> 会被 WXT 拿来当 action.default_title,
    // 那里要放运行时标题, 所以在此显式声明 (占位符由浏览器按 _locales 替换)
    action: {
      default_title: '__MSG_appShortName__',
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
      default_title: '__MSG_appShortName__',
      default_popup: '/popup.html',
    },
  },
});