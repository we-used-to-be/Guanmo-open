export type ProductTourPlacement = 'top' | 'right' | 'bottom' | 'left'

export interface ProductTourStep {
  id: string
  target: string | string[]
  title: string
  content: string
  placement: ProductTourPlacement
}

export const PRODUCT_TOUR_STEPS: ProductTourStep[] = [
  {
    id: 'open-file',
    target: [
      '[data-product-tour="open-file"]',
      '[data-product-tour="open-folder"]',
    ],
    title: '打开文件 / 文件夹',
    content: '点击这里打开文件或文件夹。\n网页端可以直接拖入 Markdown 文件；桌面端还可以将观墨设为默认 .md 应用后双击打开。',
    placement: 'right',
  },
  {
    id: 'sidebar',
    target: '[data-product-tour="sidebar-toggle"]',
    title: '文件侧边栏',
    content: '点击打开文件侧边栏。\n在这里可以更方便地浏览和管理文件。',
    placement: 'right',
  },
  {
    id: 'mode-switcher',
    target: '[data-product-tour="mode-switcher"]',
    title: '模式切换',
    content: '在这里切换不同阅读模式。\n支持编辑、预览、分屏预览和对照阅读。',
    placement: 'bottom',
  },
  {
    id: 'preview-edit',
    target: '[data-product-tour="preview-area"]',
    title: '预览内编辑',
    content: '在预览界面按 Alt + 左键，可直接定位并编辑内容。',
    placement: 'right',
  },
  {
    id: 'ai-assistant',
    target: '[data-product-tour="ai-assistant"]',
    title: 'AI 助手',
    content: '点击这里打开 AI 助手。\n你可以进行解释、问答和内容处理，也可按 Ctrl + J 快速打开。选中文本右键，或对标签右键，也能将内容关联到对话框。',
    placement: 'top',
  },
  {
    id: 'fullscreen',
    target: '[data-product-tour="fullscreen"]',
    title: '全屏模式',
    content: '点击进入全屏模式。\n配合顶部隐藏式控制条，获得更沉浸的使用体验。',
    placement: 'bottom',
  },
  {
    id: 'settings',
    target: '[data-product-tour="settings"]',
    title: '设置',
    content: '更多功能和个性化选项，可在设置中查看。',
    placement: 'right',
  },
]

export const PRODUCT_TOUR_DEMO_TAB_ID = 'guanmo-product-tour-demo'
export const PRODUCT_TOUR_DEMO_CONTENT = `# 欢迎使用观墨

观墨是一款专注 Markdown 阅读与创作的工具。

## 从这里开始

- 在预览区域按住 Alt 并左键点击，可定位到编辑器内容。
- 使用顶部模式切换，选择适合当前任务的阅读方式。
- 打开 AI 助手，获得解释、问答和内容处理帮助。
`
