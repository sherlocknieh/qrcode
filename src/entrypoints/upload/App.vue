<script lang="ts" setup>
import { ref, watch } from 'vue';

import CameraScanPanel from '@/components/CameraScanPanel.vue';
import ImageScanPanel from '@/components/ImageScanPanel.vue';
import NotifyHost from '@/components/NotifyHost.vue';
import { t } from '@/services/i18n';

// 识别页 (upload.html) 有两种取图方式: 本地/剪贴板图片 (默认) 与摄像头扫码 (?camera=1)。
// 两者共用同一个临时标签页与通知宿主, 只有中间的取图面板不同
const mode = ref<'image' | 'camera'>(
    new URLSearchParams(location.search).get('camera') === '1' ? 'camera' : 'image',
);

watch(mode, (value) => {
    document.title = t(value === 'camera' ? 'cameraScanTitle' : 'appName');
}, { immediate: true });
</script>

<template>
    <main class="upload-page">
        <CameraScanPanel v-if="mode === 'camera'" @switch-mode="mode = 'image'" />
        <ImageScanPanel v-else variant="page" />
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
