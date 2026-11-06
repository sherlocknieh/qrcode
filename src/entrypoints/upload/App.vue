<script lang="ts" setup>
import ScanPanel from '@/components/ScanPanel.vue';
import NotifyHost from '@/components/NotifyHost.vue';
import { t } from '@/services/i18n';

// 扫描页 (upload.html): 相机与本地图片共用同一个面板, 进入后由面板内的源切换决定用哪种,
// 页面只负责整页居中布局与通知宿主
document.title = t('scanCamera');
</script>

<template>
    <main class="upload-page">
        <ScanPanel />
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
