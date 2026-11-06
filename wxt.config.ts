// wxt.config.ts
import { defineConfig } from 'wxt';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 浏览器取自 `-b` 参数 (.dev/dev.mjs 与手敲的 wxt 命令都会传), 据此选 dev profile 与调试端口
const browserFlag = process.argv.indexOf('-b');
const devBrowser = (browserFlag >= 0 && process.argv[browserFlag + 1]) || 'chrome';
// Chromium 系预留的远程调试端口, 供 .dev/pin-dev-extension.mjs 连接固定 dev 图标; Firefox 不支持
const CDP_PORTS: Record<string, string> = { chrome: '9222', edge: '9223' };
const cdpPort = CDP_PORTS[devBrowser] ?? '';
// 各浏览器的 dev server 端口: 同一个浏览器只允许一个实例, 第二个要在同一个端口上报错
const DEV_SERVER_PORTS: Record<string, number> = { chrome: 3001, edge: 3002, firefox: 3000 };
const devServerPort = DEV_SERVER_PORTS[devBrowser];
// 可执行文件一律沿用用户环境变量, 脚本里不再自己探测浏览器路径
const BINARY_ENV: Record<string, string> = { chrome: 'CHROME_BINARY', edge: 'EDGE_BINARY', firefox: 'FIREFOX_BINARY' };
const binary = process.env[BINARY_ENV[devBrowser] ?? ''];

const chromiumProfile = resolve(`.wxt/dev-profile/${devBrowser}`);
const firefoxProfile = resolve('.wxt/dev-profile/firefox');

// 手机调试由 `.dev/android.mjs` 触发: 装到 Android 的任务交给 web-ext,
// wxt 只当 dev server 与打包器, 再去拉桌面 Firefox 会多开一个用不上的窗口
const androidDebug = process.env.WXT_DEV_ANDROID === '1';

// 确保 dev profile 目录存在
for (const profile of new Set([chromiumProfile, firefoxProfile])) {
  mkdirSync(profile, { recursive: true });
}

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'], // 使用 Vue 模块
  srcDir: 'src',                    // 指定源码目录
  // dev server 端口按浏览器写死在配置里: 只开 strictPort 不够 —— 没配 port 时 WXT 会从 3000
  // 往后找 3001-3010, 第二个 dev 实例就静默落到别的端口, 又把同一份 .output/<browser>-mv3-dev
  // 的页面入口改写成新端口, 已在浏览器里跑的扩展随即加载不到 popup 脚本 (弹窗空白、通知不出来)。
  // 显式给 port 后才能让 strictPort 生效: 端口被占即报错退出, 不会悄悄换端口
  dev: {
    server: {
      port: devServerPort,
      strictPort: true,
    },
  },
  webExt: {
    disabled: androidDebug,           // 手机调试时浏览器进程由 web-ext 拉起
    keepProfileChanges: true,         // 开启浏览器配置记忆, 防止每次调试都打开全新无配置的浏览器
    chromiumProfile: chromiumProfile, // Chromium 配置文件路径
    firefoxProfile: firefoxProfile,   // Firefox 配置文件路径
    chromiumArgs: cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [], // 暴露调试端口, 供 .dev/pin-dev-extension.mjs 自动固定工具栏图标
    binaries: binary ? { [devBrowser]: binary } : undefined, // 由 CHROME_BINARY 等环境变量传入
    // 调试时自动打开哪些页面
    startUrls: androidDebug ? [] : [
      // 'about:newtab',  // 新标签页
      'https://inftab.com/',
      // 'https://en.wikipedia.org/wiki/QR_code',
      // 'https://en.wikipedia.org/wiki/Barcode',
      // 'https://app.trakt.tv/favicon.svg',
      pathToFileURL(resolve('.dev/codes.pdf')).href,
    ],
  },
  manifest: ({ browser }) => ({
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
    // 扩展栏按钮的悬停提示使用短名称, 不用全名称
    action: {
      default_title: '__MSG_appShortName__',
    },

    // Firefox 地址栏按钮: Chrome/Edge 的工具栏只有 action, 没有地址栏按钮,
    // 因此只在 Firefox 构建里声明, 避免 Chrome 产物顺带塞进用不到的 19/38 图标
    ...(browser === 'firefox' ? {
      page_action: {
        default_icon: {
          19: 'icon/19.png',
          38: 'icon/38.png',
        },
        // 地址栏按钮悬停提示使用短名称, 不用全名称
        default_title: '__MSG_appShortName__',
        // 地址栏按钮点击后弹出 popup 窗口
        default_popup: '/popup.html',
      },
    } : {}),

    // Firefox 上传要求填写的项目
    browser_specific_settings: {
      gecko: {
        id: "qrcode@sherlocknieh.github.io",
        data_collection_permissions:{
          required: ['none']
        }
      },
      gecko_android: {}, // 支持 Firefox Android
    },
  }),
});
