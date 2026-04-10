/**
 * Vue Router配置
 * 
 * 定义应用的路由规则，包括：
 * 1. 路由路径和对应组件
 * 2. 路由守卫和导航逻辑
 * 3. 路由元信息
 */

// ============================================
// 导入Vue Router
// ============================================

// 从vue-router导入创建路由的函数
import { createRouter, createWebHistory } from 'vue-router'

// ============================================
// 导入页面组件
// ============================================

// 首页/欢迎页面
import HomeView from '../views/HomeView.vue'
// 聊天页面
import ChatView from '../views/ChatView.vue'

// ============================================
// 定义路由规则
// ============================================

/**
 * 路由配置数组
 * 每个路由对象包含path、name、component等属性
 */
const routes = [
  {
    // 路由路径
    path: '/',
    // 路由名称，用于编程式导航
    name: 'home',
    // 对应的组件
    component: HomeView,
    // 路由元信息
    meta: {
      // 页面标题
      title: '首页',
      // 是否需要会话
      requiresSession: false
    }
  },
  {
    path: '/chat/:sessionId?',
    name: 'chat',
    component: ChatView,
    meta: {
      title: '对话',
      requiresSession: true
    }
  },
  {
    // 历史记录页面
    path: '/history',
    name: 'history',
    // 懒加载，按需加载组件
    component: () => import('../views/HistoryView.vue'),
    meta: {
      title: '查询历史',
      requiresSession: false
    }
  },
  {
    // 数据Schema页面
    path: '/schema',
    name: 'schema',
    component: () => import('../views/SchemaView.vue'),
    meta: {
      title: '数据Schema',
      requiresSession: false
    }
  },
  {
    // 404页面
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
    meta: {
      title: '页面不存在'
    }
  }
]

// ============================================
// 创建路由实例
// ============================================

/**
 * 创建Vue Router实例
 */
const router = createRouter({
  // 使用HTML5 History模式，URL更美观（无#号）
  history: createWebHistory(),
  // 路由配置
  routes,
  // 滚动行为配置
  scrollBehavior(to, from, savedPosition) {
    // 如果有保存的滚动位置，返回该位置
    if (savedPosition) {
      return savedPosition
    }
    // 否则滚动到顶部
    return { top: 0 }
  }
})

// ============================================
// 路由守卫
// ============================================

/**
 * 全局前置守卫
 * 在路由切换前执行
 */
router.beforeEach((to, from, next) => {
  // 设置页面标题
  document.title = to.meta.title 
    ? `${to.meta.title} - 自然语言提数工具` 
    : '自然语言提数工具'
  
  // 继续导航
  next()
})

// ============================================
// 导出路由实例
// ============================================

export default router
