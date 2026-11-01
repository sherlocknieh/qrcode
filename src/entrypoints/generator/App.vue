<script lang="ts" setup>
import { onMounted, ref, watch } from 'vue';
import QrCodePanel from '@/components/QrCodePanel.vue';
import { t } from '@/services/i18n';

// 独立生成页 (generator.html): 空间更大, 适合输入长文本.
// 初始内容由 popup 通过 URL hash 传入, 避免写入存储污染右键菜单的临时文本
const text = ref('');

function readHashText(): string {
    return new URLSearchParams(location.hash.slice(1)).get('text') ?? '';
}

// 输入同步到 hash, 刷新页面不丢失内容
watch(text, (value) => {
    const hash = value ? `#text=${encodeURIComponent(value)}` : '';
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
});

onMounted(() => {
    document.title = `${t('generateQRTitle')} - ${t('appName')}`;
    text.value = readHashText();
});
</script>

<template>
    <main class="generator-page">
        <header class="generator-page-header">
            <h1 class="generator-page-title">{{ t('generateQRTitle') }}</h1>
        </header>
        <QrCodePanel v-model="text" variant="page" />
    </main>
</template>

<style scoped>
.generator-page {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    min-height: 100vh;
    padding: 40px 16px;
}

.generator-page-header {
    width: min(760px, calc(100vw - 32px));
}

.generator-page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: #0f172a;
}
</style>
