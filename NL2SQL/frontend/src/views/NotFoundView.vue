<template>
  <!-- 
    404页面
    当访问不存在的路由时显示
  -->
  <div class="not-found">
    <div class="not-found-content">
      <!-- 404图标 -->
      <el-icon class="not-found-icon"><Warning /></el-icon>
      
      <!-- 错误代码 -->
      <h1 class="error-code">404</h1>
      
      <!-- 错误信息 -->
      <h2 class="error-title">页面不存在</h2>
      <p class="error-desc">
        抱歉，您访问的页面不存在或已被移除
      </p>
      
      <!-- 返回按钮 -->
      <div class="actions">
        <el-button type="primary" :icon="Back" @click="goBack">
          返回上一页
        </el-button>
        <el-button :icon="HomeFilled" @click="goHome">
          返回首页
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 404页面组件脚本
 */

// ============================================
// 导入依赖
// ============================================

// 导入Vue Router
import { useRouter } from 'vue-router'
// 导入Element Plus图标
import { Warning, Back, HomeFilled } from '@element-plus/icons-vue'

// ============================================
// 路由
// ============================================

// 获取路由实例
const router = useRouter()

// ============================================
// 方法
// ============================================

/**
 * 返回上一页
 */
function goBack() {
  router.back()
}

/**
 * 返回首页
 */
function goHome() {
  router.push('/')
}
</script>

<style scoped>
/**
 * 组件样式
 */

/* 404页面容器 */
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  background-color: #f5f7fa;
}

/* 内容区域 */
.not-found-content {
  text-align: center;
  padding: 40px;
}

/* 图标 */
.not-found-icon {
  font-size: 80px;
  color: #e6a23c;
  margin-bottom: 24px;
}

/* 错误代码 */
.error-code {
  font-size: 120px;
  font-weight: 700;
  color: #303133;
  margin: 0 0 16px 0;
  line-height: 1;
}

/* 错误标题 */
.error-title {
  font-size: 28px;
  font-weight: 600;
  color: #303133;
  margin: 0 0 12px 0;
}

/* 错误描述 */
.error-desc {
  font-size: 16px;
  color: #606266;
  margin: 0 0 32px 0;
}

/* 操作按钮 */
.actions {
  display: flex;
  justify-content: center;
  gap: 16px;
}
</style>
