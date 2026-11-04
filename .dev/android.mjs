// `pnpm dev:android`: 用 USB + adb 把 dev 扩展装到 Firefox for Android, 不拉起桌面浏览器.
// wxt 在这里只当 dev server 与打包器; 装包交给 web-ext, dev server 端口经 adb reverse 打通供热更新.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { relative, resolve } from 'node:path';
import readline from 'node:readline';

// 与 wxt.config.ts 的端口约定一致 (Firefox 3000), 手机侧热更新连的就是这个端口
const DEV_SERVER_PORT = 3000;
const OUT_DIR = resolve('.output/firefox-mv3-dev');
const FIREFOX_ANDROID_APK = 'org.mozilla.firefox';

const sleep = ms => new Promise(done => setTimeout(done, ms));

// 直接 `node .dev/android.mjs` 运行时 PATH 里没有 node_modules/.bin, 优先用本地可执行文件
function localCommand(name) {
  const local = resolve(`node_modules/.bin/${name}` + (process.platform === 'win32' ? '.cmd' : ''));
  return existsSync(local) ? local : name;
}

function pipeWithPrefix(child, prefix) {
  for (const stream of [child.stdout, child.stderr]) {
    // 按行加前缀转发: 直接 pipe 会切碎成半行, 两路子进程日志混在一起更难读
    readline.createInterface({ input: stream }).on('line', line => {
      process.stdout.write(`${prefix}${line}\n`);
    });
  }
}

let runner = null;    // web-ext 子进程
let reversed = null;  // 已建 reverse 的设备, 退出时拆掉, 免得占着手机端口
let stopped = false;

const startedAt = Date.now();
// 桌面浏览器由 web-ext 拉起 (WXT_DEV_ANDROID 让 wxt.config.ts 跳过 webExt)
const wxt = spawn(localCommand('wxt'), ['-b', 'firefox', '-p', String(DEV_SERVER_PORT), '--mv3'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, WXT_DEV_ANDROID: '1' },
});
pipeWithPrefix(wxt, '[wxt] ');

// 等 close 才往下走: 只发 SIGTERM 就退出的话, 子进程可能还没退干净就交还了终端
function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(done => {
    child.once('close', done);
    child.kill('SIGTERM');
    // 兜底: 子进程不响应 SIGTERM 时也别让终端一直挂着
    setTimeout(done, 3000).unref();
  });
}

async function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  dropReverse();
  await Promise.all([stopChild(runner), stopChild(wxt)]);
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(0));
wxt.on('close', code => shutdown(code ?? 0));
wxt.on('error', error => {
  console.error(`✖ 启动 wxt 失败: ${error.message}`);
  shutdown(1);
});

// SDK 里的 adb 通常不在 PATH 上, 先按常见位置找, 再退回 PATH
function resolveAdb() {
  const override = process.env.ADB_BIN;
  if (override) return override;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, resolve(homedir(), 'Android/Sdk')];
  return roots.filter(Boolean).map(root => resolve(root, 'platform-tools', exe)).find(existsSync) ?? 'adb';
}

function pickAndroidDevice(adb) {
  const preferred = process.env.ANDROID_DEVICE;
  if (preferred) return { serial: preferred };

  const listed = spawnSync(adb, ['devices'], { encoding: 'utf8' });
  if (listed.error) {
    return { error: `执行 adb 失败 (${adb}), 请安装 Android SDK platform-tools, 或用 ADB_BIN 指定 adb 路径` };
  }
  const rows = listed.stdout.split('\n').slice(1)
    .map(row => row.trim().split(/\s+/))
    .filter(([serial]) => serial);
  const ready = rows.filter(([, state]) => state === 'device').map(([serial]) => serial);
  if (ready.length === 1) return { serial: ready[0] };
  if (ready.length > 1) return { error: `检测到多台设备 (${ready.join(', ')}), 请用 ANDROID_DEVICE 指定序列号` };

  const pending = rows.filter(([, state]) => state !== 'device');
  return {
    error: pending.length
      ? `设备未就绪: ${pending.map(([serial, state]) => `${serial} (${state})`).join(', ')}, 请在手机上确认 USB 调试授权`
      : '没有检测到 Android 设备, 请用 USB 连接手机并打开 USB 调试',
  };
}

// wxt 启动时会重建 outDir; 只有晚于本轮启动时刻写出的 manifest 才说明 dev 版已就绪.
// 直接判断文件存在会读到上一轮残留的产物, web-ext 会装上过期的扩展
async function waitForFreshManifest(timeoutMs = 120_000) {
  const manifest = resolve(OUT_DIR, 'manifest.json');
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (existsSync(manifest) && statSync(manifest).mtimeMs >= startedAt) return true;
    await sleep(300);
  }
  return false;
}

// 手机常常比 dev server 晚接上, 找不到设备时不退出, 保持 dev server 运行并持续重试
async function waitForDevice() {
  let lastMessage = '';
  while (!stopped) {
    const adb = resolveAdb();
    const picked = pickAndroidDevice(adb);
    if (picked.serial) return { adb, serial: picked.serial };
    // 同一句提示每 5 秒重复一次会淹掉构建日志, 只在状态变化时打印
    if (picked.error !== lastMessage) {
      lastMessage = picked.error;
      console.log(`ℹ ${picked.error}`);
      console.log('ℹ 5 秒后重试...');
    }
    await sleep(5000);
  }
  return null;
}

function dropReverse() {
  if (!reversed) return;
  spawnSync(resolveAdb(), ['-s', reversed, 'reverse', '--remove', `tcp:${DEV_SERVER_PORT}`], { stdio: 'ignore' });
  reversed = null;
}

async function install() {
  const device = await waitForDevice();
  if (!device) return;

  if (!(await waitForFreshManifest())) {
    if (!stopped) console.error(`✖ 等待 ${relative(process.cwd(), OUT_DIR)} 构建超时, 手机调试未启动`);
    return;
  }
  if (stopped) return;

  const { adb, serial } = device;
  // 手机上的 localhost 只有经 adb reverse 才通到本机, 而 wxt 热更新默认连 localhost:<port>
  const result = spawnSync(adb, ['-s', serial, 'reverse', `tcp:${DEV_SERVER_PORT}`, `tcp:${DEV_SERVER_PORT}`], { encoding: 'utf8' });
  if (result.status === 0) reversed = serial;
  else console.warn(`⚠ adb reverse 失败, 手机将收不到热更新: ${(result.stderr || '').trim()}`);
  if (stopped) return dropReverse();

  const apk = process.env.FIREFOX_APK ?? FIREFOX_ANDROID_APK;
  console.log(`ℹ 安装到 ${serial} (${apk})`);
  const child = spawn(localCommand('web-ext'), [
    'run',
    '--target=firefox-android',
    '--source-dir', OUT_DIR,
    '--android-device', serial,
    '--firefox-apk', apk,
    '--adb-bin', adb,
    '--artifacts-dir', resolve('.wxt/web-ext-artifacts'),
    // 热更新由 wxt 的 dev server 推送; 打开 web-ext 的监听会每次保存都重新打包推包,
    // 和 wxt 的 reload 叠成两次扩展重启
    '--no-reload',
    '--no-input',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  runner = child;
  pipeWithPrefix(child, '[android] ');

  child.on('error', error => console.error(`✖ 启动 web-ext 失败: ${error.message}`));
  child.on('close', code => {
    if (runner === child) runner = null;
    // 装包进程走掉后没人再给手机推包, dev server 留着只会空转, 一并收掉
    if (stopped) return;
    console.error(`✖ web-ext 退出 (${code ?? 0}), 重新运行 pnpm dev:android 可再装一次`);
    shutdown(code || 1);
  });
}

console.log('ℹ 手机调试: 等待设备与首次构建完成');
install();
