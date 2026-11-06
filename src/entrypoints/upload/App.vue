<script lang="ts" setup>
import LocalScanPanel from '@/components/LocalScanPanel.vue';
import NotifyHost from '@/components/NotifyHost.vue';

// 扫描页 (upload.html): 相机与本地图片共用同一个面板, 进入后由面板内的源切换决定用哪种,
// 页面只负责整页居中布局与通知宿主; 标签页标题由面板按当前源设置
</script>

<template>
    <main class="upload-page">
        <LocalScanPanel />
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
