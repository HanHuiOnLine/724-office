<template>
  <!-- 
    根组件模板
    这是整个应用的布局框架，包含侧边栏和主内容区
  -->
  <div class="app-container">
    <!-- 
      侧边栏
      包含Logo、导航菜单、会话列表等
    -->
    <aside class="sidebar" :class="{ collapsed: isCollapsed }">
      <!-- Logo区域 -->
      <div class="logo">
        <el-icon class="logo-icon"><DataLine /></el-icon>
        <span v-show="!isCollapsed" class="logo-text">NL2SQL</span>
      </div>
      
      <!-- 新建会话按钮 -->
      <div class="new-chat">
        <el-button 
          type="primary" 
          :icon="Plus" 
          :class="{ 'is-collapsed': isCollapsed }"
          @click="createNewSession"
        >
          <span v-show="!isCollapsed">新建会话</span>
        </el-button>
      </div>
      
      <!-- 会话列表 -->
      <div class="session-list" v-show="!isCollapsed">
        <div class="session-title">历史会话</div>
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-item"
          :class="{ active: currentSessionId === session.id }"
          @click="switchSession(session.id)"
        >
          <el-icon><ChatDotRound /></el-icon>
          <span class="session-name">{{ session.title || '新会话' }}</span>
        </div>
      </div>
      
      <!-- 底部工具栏 -->
      <div class="sidebar-footer">
        <el-tooltip content="数据Schema" placement="right">
          <el-button text :icon="Grid" @click="showSchema = true" />
        </el-tooltip>
        <el-tooltip content="设置" placement="right">
          <el-button text :icon="Setting" />
        </el-tooltip>
        <el-tooltip :content="isCollapsed ? '展开' : '收起'" placement="right">
          <el-button text :icon="isCollapsed ? Expand : Fold" @click="toggleSidebar" />
        </el-tooltip>
      </div>
    </aside>
    
    <!-- 
      主内容区
      包含路由视图，显示当前页面
    -->
    <main class="main-content">
      <router-view />
    </main>
    
    <!-- Schema查看弹窗 -->
    <SchemaViewer v-model="showSchema" />
  </div>
</template>

<script setup>
/**
 * 根组件脚本
 * 
 * 使用Vue3的Composition API和<script setup>语法
 */

// ============================================
// 导入依赖
// ============================================

// 从Vue导入响应式API和生命周期钩子
import { ref, onMounted } from 'vue'
// 从Vue Router导入路由相关API
import { useRouter } from 'vue-router'
// 导入Element Plus图标组件
import { 
  Plus, 
  ChatDotRound, 
  Grid, 
  Setting, 
  Fold, 
  Expand,
  DataLine 
} from '@element-plus/icons-vue'
// 导入会话状态管理
import { useSessionStore } from './stores/session'
// 导入Schema查看组件
import SchemaViewer from './components/SchemaViewer.vue'

// ============================================
// 响应式状态
// ============================================

// 侧边栏收起状态
const isCollapsed = ref(false)
// 是否显示Schema弹窗
const showSchema = ref(false)

// ============================================
// 状态管理
// ============================================

// 获取会话状态管理store
const sessionStore = useSessionStore()
// 从store获取会话列表
const sessions = sessionStore.sessions
// 从store获取当前会话ID
const currentSessionId = sessionStore.currentSessionId

// ============================================
// 路由
// ============================================

// 获取路由实例
const router = useRouter()

// ============================================
// 方法
// ============================================

/**
 * 切换侧边栏展开/收起
 */
function toggleSidebar() {
  isCollapsed.value = !isCollapsed.value
}

/**
 * 创建新会话
 * 调用store的方法创建会话，并跳转到聊天页面
 */
async function createNewSession() {
  // 调用store创建新会话
  const sessionId = await sessionStore.createSession()
  // 跳转到聊天页面
  router.push(`/chat/${sessionId}`)
}

/**
 * 切换会话
 * @param {string} sessionId - 会话ID
 */
function switchSession(sessionId) {
  // 设置当前会话
  sessionStore.setCurrentSession(sessionId)
  // 跳转到对应会话的聊天页面
  router.push(`/chat/${sessionId}`)
}

// ============================================
// 生命周期钩子
// ============================================

/**
 * 组件挂载时执行
 */
onMounted(() => {
  // 加载会话列表
  sessionStore.loadSessions()
})
</script>

<style scoped>
/**
 * 组件样式
 * 使用scoped属性确保样式只作用于当前组件
 */

/* 应用容器：全屏布局 */
.app-container {
  display: flex;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: 260px;
  height: 100%;
  background-color: #f5f5f5;
  border-right: 1px solid #e0e0e0;
  display: flex;
  flex-direction: column;
  transition: width 0.3s ease;
}

/* 收起状态的侧边栏 */
.sidebar.collapsed {
  width: 64px;
}

/* Logo区域 */
.logo {
  height: 60px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid #e0e0e0;
}

.logo-icon {
  font-size: 28px;
  color: #409eff;
}

.logo-text {
  margin-left: 12px;
  font-size: 20px;
  font-weight: 600;
  color: #303133;
}

/* 新建会话按钮区域 */
.new-chat {
  padding: 16px;
}

.new-chat .el-button {
  width: 100%;
  justify-content: flex-start;
}

.new-chat .el-button.is-collapsed {
  justify-content: center;
  padding: 12px;
}

/* 会话列表 */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 12px;
}

.session-title {
  font-size: 12px;
  color: #909399;
  padding: 8px 4px;
  margin-bottom: 8px;
}

.session-item {
  display: flex;
  align-items: center;
  padding: 10px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.session-item:hover {
  background-color: #e6e6e6;
}

.session-item.active {
  background-color: #ecf5ff;
  color: #409eff;
}

.session-name {
  margin-left: 8px;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 侧边栏底部工具栏 */
.sidebar-footer {
  padding: 12px;
  border-top: 1px solid #e0e0e0;
  display: flex;
  justify-content: space-around;
}

/* 主内容区 */
.main-content {
  flex: 1;
  overflow: hidden;
  background-color: #ffffff;
}
</style>
