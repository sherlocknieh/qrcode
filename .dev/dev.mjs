// dev 入口:
// - `pnpm dev`                     → 同时启动 Chrome/Edge/Firefox, 没装的浏览器静默跳过
// - `pnpm dev:chrome|edge|firefox` → 只启动指定浏览器, 没装则报错退出
// 启动的同时会把 Chromium 系浏览器的 dev 扩展自动固定到工具栏.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { watchDevExtensionPin } from './pin-dev-extension.mjs';

const ALL_BROWSERS = ['chrome', 'edge', 'firefox'];
const DEV_SERVER_PORTS = { chrome: 3000, edge: 3001, firefox: 3002 };
const DEBUG_PORTS = { chrome: 9222, edge: 9223 }; // Firefox 没有 CDP, 不支持自动固定图标

const BINARY_ENV = { chrome: 'CHROME_BINARY', edge: 'EDGE_BINARY', firefox: 'FIREFOX_BINARY' };
const PATH_NAMES = {
  chrome: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
  edge: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
  firefox: ['firefox', 'firefox-esr'],
};

const args = process.argv.slice(2);

// 直接 `node .dev/dev.mjs` 运行时 PATH 里没有 node_modules/.bin, 优先用本地 wxt
const localWxt = resolve('node_modules/.bin/wxt' + (process.platform === 'win32' ? '.cmd' : ''));
const WXT_COMMAND = existsSync(localWxt) ? localWxt : 'wxt';

const children = new Map();
const launched = new Map(); // browser -> 启动参数, 供重启复用
let exitCode = 0;
let shuttingDown = false;
let restarting = false;
let stopWatching = () => {};

function readBrowser() {
  const inline = args.find(arg => arg.startsWith('--browser='));
  if (inline) return inline.slice('--browser='.length);
  const index = args.findIndex(arg => arg === '-b' || arg === '--browser');
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function withoutBrowserArgs() {
  return args.filter((arg, index) => {
    if (arg === '-b' || arg === '--browser' || arg.startsWith('--browser=')) return false;
    const previous = args[index - 1];
    return previous !== '-b' && previous !== '--browser';
  });
}

// 用户显式传了端口就尊重用户, 否则用按浏览器固定的端口
function hasPortArg(list) {
  return list.some(arg => arg === '-p' || arg === '--port' || arg.startsWith('--port='));
}

function knownBinaryPaths(browser) {
  const env = process.env;
  if (process.platform === 'win32') {
    const map = {
      chrome: [
        env.ProgramFiles && `${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      edge: [
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
        env.ProgramFiles && `${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
        env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
      firefox: [
        env.ProgramFiles && `${env.ProgramFiles}\\Mozilla Firefox\\firefox.exe`,
        env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Mozilla Firefox\\firefox.exe`,
      ],
    };
    return map[browser].filter(Boolean);
  }

  if (process.platform === 'darwin') {
    return {
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    }[browser];
  }

  return {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'],
    firefox: ['/usr/bin/firefox', '/usr/bin/firefox-esr'],
  }[browser];
}

function onPath(names) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return names.some(name => spawnSync(lookup, [name], { stdio: 'ignore' }).status === 0);
}

/**
 * 返回可执行文件绝对路径; 装好了但交给浏览器自身默认探测即可时返回空字符串; 没装返回 null.
 */
function resolveBrowserBinary(browser) {
  const override = process.env[BINARY_ENV[browser]];
  if (override) return override;

  const found = knownBinaryPaths(browser).find(path => existsSync(path));
  if (found) return found;

  return onPath(PATH_NAMES[browser]) ? '' : null;
}

function buildEnv(browser, binary) {
  const env = { ...process.env, WXT_DEV_BROWSER: browser };
  if (DEBUG_PORTS[browser]) env.WXT_DEV_CDP_PORT = String(DEBUG_PORTS[browser]);
  // wxt.config.ts 直接读同名的用户环境变量
  if (binary) env[BINARY_ENV[browser]] = binary;
  return env;
}

function spawnWxt(browser, wxtArgs, { binary, interactive }) {
  const child = spawn(WXT_COMMAND, wxtArgs, {
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: buildEnv(browser, binary),
  });
  children.set(browser, child);

  if (!interactive) {
    const prefix = `[${browser}] `;
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on('line', line => {
        process.stdout.write(`${prefix}${line}\n`);
      });
    }
  }

  child.on('error', error => {
    console.error(`[${browser}] 启动失败: ${error.message}`);
  });

  launched.set(browser, { args: wxtArgs, binary, interactive });
  // 用 close 而不是 exit: 启动失败(ENOENT 等)时只会有 close
  child.on('close', code => {
    children.delete(browser);
    if (shuttingDown || restarting) return;
    if (code) exitCode = code;
    // 多浏览器模式下等所有子进程退出; 单浏览器模式自然只剩一个
    if (children.size === 0) process.exit(exitCode);
  });
}

// 多进程模式下子进程拿不到 TTY, wxt 自带的 o + enter 不生效, 由父进程接管
async function restartAll() {
  if (restarting || shuttingDown) return;
  restarting = true;
  console.log('ℹ 重新打开浏览器...');

  const records = [...launched.entries()];
  await Promise.all(records.map(([browser]) => stopChild(browser)));
  restarting = false;
  if (shuttingDown) return;
  for (const [browser, record] of records) {
    spawnWxt(browser, record.args, record);
  }
}

function stopChild(browser) {
  const child = children.get(browser);
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(done => {
    child.once('close', done);
    child.kill('SIGTERM');
  });
}

function listenShortcuts() {
  if (!process.stdin.isTTY) return;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    if (line.trim() === 'o') restartAll();
  });
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopWatching();
  for (const child of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(exitCode), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const explicitBrowser = readBrowser();

if (explicitBrowser && !ALL_BROWSERS.includes(explicitBrowser)) {
  console.error(`✖ 不支持的浏览器: ${explicitBrowser}, 可选: ${ALL_BROWSERS.join(' / ')}`);
  process.exit(1);
}

// `pnpm dev:xxx` 缺浏览器要报错; `pnpm dev` 静默跳过没装的
const binaries = Object.fromEntries(ALL_BROWSERS.map(browser => [browser, resolveBrowserBinary(browser)]));
const browsers = explicitBrowser ? [explicitBrowser] : ALL_BROWSERS.filter(browser => binaries[browser] !== null);

if (browsers.length === 0) {
  console.error('✖ 没有找到任何可用的浏览器, 请先安装 Chrome / Edge / Firefox');
  process.exit(1);
}
if (explicitBrowser && binaries[explicitBrowser] === null) {
  console.error(`✖ 未找到 ${explicitBrowser}, 请先安装, 或用环境变量 ${BINARY_ENV[explicitBrowser]} 指定可执行文件路径`);
  process.exit(1);
}

// 端口必须固定: 换端口后已加载的 dev 扩展仍连旧端口, 热更新/重载会失效.
// 单浏览器与多浏览器共用同一套端口, 同一浏览器的两次启动才对得上.
const baseArgs = withoutBrowserArgs();
const useFixedPort = !hasPortArg(baseArgs);
const interactive = Boolean(explicitBrowser); // 单浏览器继承 stdin, 交给 wxt 自己处理 o 键

for (const browser of browsers) {
  const wxtArgs = [
    '-b',
    browser,
    ...(useFixedPort ? ['-p', String(DEV_SERVER_PORTS[browser])] : []),
    ...baseArgs,
  ];
  if (browser === 'firefox') wxtArgs.push('--mv3');

  console.log(`ℹ ${browser}${binaries[browser] ? `: ${binaries[browser]}` : ''}`);
  spawnWxt(browser, wxtArgs, { binary: binaries[browser], interactive });
}

if (!interactive) {
  console.log(`ℹ 同时调试: ${browsers.join(' / ')}`);
  console.log('ℹ 输入 o + enter 可重新打开所有浏览器');
  listenShortcuts();
}

stopWatching = watchDevExtensionPin({
  targets: browsers
    .filter(browser => DEBUG_PORTS[browser])
    .map(browser => ({
      port: DEBUG_PORTS[browser],
      extensionDir: resolve(`.output/${browser}-mv3-dev`),
      label: browser,
    })),
});
