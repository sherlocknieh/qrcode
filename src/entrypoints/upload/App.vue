<script lang="ts" setup>
import ScanPanel from '@/components/ScanPanel.vue';
import NotifyHost from '@/components/NotifyHost.vue';
import { t } from '@/services/i18n';

// 扫描页 (upload.html): 图片扫描与摄像头扫描共用一个面板,
// 带 ?camera=1 时直接进入摄像头模式, 页面只提供整页居中布局与通知宿主。
// 源由入口决定, 面板内不再互相切换, 所以这里没有可变的模式状态
const mode = new URLSearchParams(location.search).get('camera') === '1' ? 'camera' : 'image';

document.title = t(mode === 'camera' ? 'scanCamera' : 'appName');
</script>

<template>
    <main class="upload-page">
        <ScanPanel :mode="mode" />
        <NotifyHost />
    </main>
</template>

<style scoped>
.upload-page {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 32px 16px;
}
</style>
