/**
 * Vite配置文件
 * 
 * 配置前端构建工具Vite的各项参数
 * 包括：开发服务器、路径别名、插件等
 */

// 导入Vite的Vue插件，用于支持Vue3单文件组件
import vue from '@vitejs/plugin-vue'
// 导入Node.js的path模块，用于处理文件路径
import { resolve } from 'path'

/**
 * 导出Vite配置对象
 * @type {import('vite').UserConfig}
 */
export default {
  // 配置开发服务器
  server: {
    // 监听端口
    port: 5173,
    // 自动打开浏览器
    open: true,
    // 配置代理，解决开发环境跨域问题
    proxy: {
      // 将/api开头的请求代理到后端服务
      '/api': {
        // 后端服务地址
        target: 'http://localhost:3000',
        // 改变请求的origin，使其与后端服务一致
        changeOrigin: true
      },

    }
  },
  
  // 配置路径别名
  resolve: {
    alias: {
      // @符号指向src目录，方便导入组件
      '@': resolve(__dirname, 'src'),
      // @components指向组件目录
      '@components': resolve(__dirname, 'src/components'),
      // @views指向页面目录
      '@views': resolve(__dirname, 'src/views'),
      // @stores指向状态管理目录
      '@stores': resolve(__dirname, 'src/stores'),
      // @utils指向工具函数目录
      '@utils': resolve(__dirname, 'src/utils')
    }
  },
  
  // 配置插件
  plugins: [
    // 启用Vue3支持
    vue()
  ],
  
  // 配置CSS
  css: {
    // 配置CSS预处理器
    preprocessorOptions: {
      // SCSS配置
      scss: {
        // 自动导入Element Plus的变量，方便使用
        additionalData: `@use "element-plus/theme-chalk/src/common/var.scss" as *;`
      }
    }
  },
  
  // 配置构建输出
  build: {
    // 输出目录
    outDir: 'dist',
    // 是否生成source map（生产环境建议关闭）
    sourcemap: false,
    // 配置代码分割
    rollupOptions: {
      output: {
        // 将第三方库单独打包
        manualChunks: {
          // Element Plus单独打包
          'element-plus': ['element-plus'],
          // ECharts单独打包
          'echarts': ['echarts', 'vue-echarts'],
          // 工具库单独打包
          'vendor': ['vue', 'vue-router', 'pinia', 'axios']
        }
      }
    }
  }
}
