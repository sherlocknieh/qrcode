<script lang="ts" setup>
import { ref, watch } from 'vue';

import ScanPanel from '@/components/ScanPanel.vue';
import NotifyHost from '@/components/NotifyHost.vue';
import { t } from '@/services/i18n';

// 识别页 (upload.html): 图片识别与摄像头识别共用一个面板,
// 带 ?camera=1 时直接进入摄像头模式, 页面只提供整页居中布局与通知宿主
const mode = ref<'image' | 'camera'>(
    new URLSearchParams(location.search).get('camera') === '1' ? 'camera' : 'image',
);

watch(mode, (value) => {
    document.title = t(value === 'camera' ? 'cameraScanTitle' : 'appName');
}, { immediate: true });
</script>

<template>
    <main class="upload-page">
        <ScanPanel v-model:mode="mode" />
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
