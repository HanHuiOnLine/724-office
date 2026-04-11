/**
 * Markdown 渲染工具模块
 * 
 * 集成：
 * 1. markdown-it - Markdown 解析
 * 2. Shiki - 代码高亮
 * 3. Mermaid.js - 图表和流程图
 * 4. KaTeX - 数学公式
 */

// ============================================
// 导入依赖
// ============================================

import MarkdownIt from 'markdown-it'
import mermaid from 'mermaid'
import katex from 'katex'
import 'katex/dist/katex.min.css'

// ============================================
// 初始化 Mermaid
// ============================================

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'strict',
  flowchart: {
    useMaxWidth: true,
    htmlLabels: true,
    curve: 'basis'
  },
  sequence: {
    useMaxWidth: true,
    wrap: true
  },
  gantt: {
    useMaxWidth: true
  }
})

// ============================================
// 初始化 Shiki
// ============================================

let shikiHighlighter = null

/**
 * 初始化 Shiki 高亮器
 */
async function initShiki() {
  if (shikiHighlighter) return shikiHighlighter
  
  try {
    const { createHighlighter } = await import('shiki')
    shikiHighlighter = await createHighlighter({
      themes: ['one-dark-pro'],
      langs: ['sql', 'javascript', 'python', 'java', 'json', 'yaml', 'markdown', 'html', 'css', 'bash', 'powershell']
    })
    return shikiHighlighter
  } catch (error) {
    console.warn('Shiki 初始化失败，将使用备用高亮:', error)
    return null
  }
}

// 立即初始化
initShiki()

// ============================================
// 创建 Markdown-it 实例
// ============================================

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: function (str, lang) {
    // 如果是 mermaid 图表，特殊处理
    if (lang === 'mermaid') {
      return `<div class="mermaid">${str}</div>`
    }
    
    // 如果是数学公式，特殊处理
    if (lang === 'math' || lang === 'latex') {
      try {
        return katex.renderToString(str, {
          throwOnError: false,
          displayMode: true
        })
      } catch (error) {
        return `<pre class="katex-error">${str}</pre>`
      }
    }
    
    // 其他代码使用 Shiki 高亮（异步，这里返回占位符）
    return `<pre><code class="language-${lang}">${escapeHtml(str)}</code></pre>`
  }
})

// ============================================
// 工具函数
// ============================================

/**
 * HTML 转义
 */
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }
  return text.replace(/[&<>"']/g, m => map[m])
}

/**
 * 处理行内数学公式
 * 支持 $...$ 和 $$...$$ 语法
 */
function processMath(content) {
  // 处理块级公式 $$...$$
  content = content.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
    try {
      return katex.renderToString(formula.trim(), {
        throwOnError: false,
        displayMode: true
      })
    } catch (error) {
      return match
    }
  })
  
  // 处理行内公式 $...$
  content = content.replace(/\$([^$\n]+)\$/g, (match, formula) => {
    try {
      return katex.renderToString(formula.trim(), {
        throwOnError: false,
        displayMode: false
      })
    } catch (error) {
      return match
    }
  })
  
  return content
}

/**
 * 渲染 Mermaid 图表
 * @param {string} containerSelector - 容器选择器
 */
export async function renderMermaidCharts(containerSelector = '.mermaid') {
  const elements = document.querySelectorAll(containerSelector)
  if (elements.length === 0) return
  
  try {
    await mermaid.run({
      nodes: Array.from(elements)
    })
  } catch (error) {
    console.error('Mermaid 渲染失败:', error)
    elements.forEach(el => {
      el.innerHTML = `<pre class="mermaid-error">图表渲染失败: ${error.message}</pre>`
    })
  }
}

// ============================================
// 主要渲染函数
// ============================================

/**
 * 渲染 Markdown 内容
 * @param {string} content - Markdown 文本
 * @returns {string} HTML 字符串
 */
export function renderMarkdown(content) {
  if (!content) return ''
  
  // 先处理数学公式
  let processedContent = processMath(content)
  
  // 渲染 Markdown
  const html = md.render(processedContent)
  
  // 在下一个 tick 渲染 Mermaid 图表
  setTimeout(() => {
    renderMermaidCharts()
  }, 0)
  
  return html
}

/**
 * 渲染 SQL 代码（使用 Shiki 高亮）
 * @param {string} sql - SQL 代码
 * @returns {string} HTML 字符串
 */
export function renderSQL(sql) {
  if (!sql) return ''
  
  // 如果 Shiki 已初始化，使用它
  if (shikiHighlighter) {
    try {
      return shikiHighlighter.codeToHtml(sql, {
        lang: 'sql',
        theme: 'one-dark-pro'
      })
    } catch (error) {
      console.warn('Shiki 高亮失败:', error)
    }
  }
  
  // 备用：简单的高亮
  return `<pre class="shiki" style="background-color: #282c34; padding: 16px; border-radius: 6px; overflow-x: auto;"><code style="color: #abb2bf; font-family: 'Courier New', monospace;">${escapeHtml(sql)}</code></pre>`
}

/**
 * 高亮任意代码
 * @param {string} code - 代码内容
 * @param {string} lang - 语言
 * @returns {string} HTML 字符串
 */
export async function highlightCode(code, lang = 'text') {
  if (!code) return ''
  
  const highlighter = await initShiki()
  
  if (highlighter) {
    try {
      return highlighter.codeToHtml(code, {
        lang: lang,
        theme: 'one-dark-pro'
      })
    } catch (error) {
      console.warn('Shiki 高亮失败:', error)
    }
  }
  
  // 备用
  return `<pre class="shiki" style="background-color: #282c34; padding: 16px; border-radius: 6px; overflow-x: auto;"><code style="color: #abb2bf; font-family: 'Courier New', monospace;">${escapeHtml(code)}</code></pre>`
}

// ============================================
// 导出
// ============================================

export default {
  renderMarkdown,
  renderSQL,
  highlightCode,
  renderMermaidCharts
}
