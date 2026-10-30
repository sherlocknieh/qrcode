<script lang="ts" setup>
import { onMounted } from 'vue';

import NotifyHost from '@/components/NotifyHost.vue';
import ImageScanPanel from '@/components/ImageScanPanel.vue';
import { t } from '@/services/i18n';

// 独立识别页: 页面无法注入内容脚本时的兜底入口。
// 取图/预览/识别与页面内浮层共用 ImageScanPanel, 本页只提供整页居中布局
onMounted(() => {
    document.title = t('appName');
});
</script>

<template>
    <main class="scan-page">
        <ImageScanPanel variant="page" />
        <NotifyHost />
    </main>
</template>

<style scoped>
.scan-page {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 32px 16px;
}
</style>
