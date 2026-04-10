/**
 * Vue应用入口文件
 * 
 * 这是前端应用的入口点，负责：
 * 1. 创建Vue应用实例
 * 2. 安装插件（路由、状态管理、UI组件库等）
 * 3. 挂载应用到DOM
 */

// ============================================
// 导入Vue核心
// ============================================

// 从vue包导入createApp函数，用于创建Vue3应用实例
import { createApp } from 'vue'

// ============================================
// 导入根组件
// ============================================

// 导入根组件App.vue，这是整个应用的根组件
import App from './App.vue'

// ============================================
// 导入插件
// ============================================

// 导入路由配置
import router from './router'
// 导入Pinia状态管理实例
import pinia from './stores'

// ============================================
// 导入Element Plus
// ============================================

// 导入Element Plus组件库
import ElementPlus from 'element-plus'
// 导入Element Plus的CSS样式
import 'element-plus/dist/index.css'
// 导入Element Plus图标
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

// ============================================
// 导入全局样式
// ============================================

// 导入全局CSS样式文件
import './styles/global.css'

// ============================================
// 创建Vue应用实例
// ============================================

// 调用createApp函数，传入根组件，创建应用实例
const app = createApp(App)

// ============================================
// 安装插件
// ============================================

// 安装Vue Router插件，启用路由功能
app.use(router)

// 安装Pinia插件，启用状态管理
app.use(pinia)

// 安装Element Plus插件，启用UI组件库
app.use(ElementPlus)

// ============================================
// 注册全局组件
// ============================================

// 遍历所有Element Plus图标，注册为全局组件
// 这样在任何组件中都可以直接使用<el-icon-xxx>标签
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  // 使用component方法注册全局组件
  app.component(key, component)
}

// ============================================
// 挂载应用
// ============================================

// 将Vue应用挂载到DOM元素上
// 参数'#app'是CSS选择器，对应index.html中的<div id="app">
app.mount('#app')
