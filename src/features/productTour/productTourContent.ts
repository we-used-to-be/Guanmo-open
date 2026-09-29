export type ProductTourPlacement = 'top' | 'right' | 'bottom' | 'left'
export type ProductTourTopic = 'overview' | 'files' | 'fullscreen' | 'annotations' | 'ai' | 'appearance'
export type ProductTourSurface = 'collapsed' | 'sidebar' | 'preview' | 'fullscreen' | 'ai-chat' | 'artifacts' | 'settings-ai' | 'settings-general'

export interface ProductTourStep {
  id: string
  target: string | string[]
  title: string
  content: string
  placement: ProductTourPlacement
  surface: ProductTourSurface
  example?: 'annotation'
  desktopOnly?: boolean
}

export const PRODUCT_TOUR_TOPICS: Array<{ id: ProductTourTopic; title: string; description: string; desktopOnly?: boolean }> = [
  { id: 'files', title: '文件与阅读', description: '文件、侧栏、阅读模式和预览' },
  { id: 'fullscreen', title: '全屏模式', description: '控制条、AI 小窗、正文边距和文件切换' },
  { id: 'annotations', title: '批注与阅读成果', description: '高亮、文字批注与成果管理', desktopOnly: true },
  { id: 'ai', title: 'AI 助手', description: '对话、选区与模型设置' },
  { id: 'appearance', title: '主题与个性设置', description: '主题选择与自定义' },
]

const steps: Record<ProductTourTopic, ProductTourStep[]> = {
  overview: [
    { id: 'open-file', target: '[data-product-tour="open-file"]', title: '打开 Markdown', content: '从这里打开 .md 文件。桌面版也支持打开文件夹；网页端可以拖入文件，目录功能取决于浏览器支持。', placement: 'right', surface: 'collapsed' },
    { id: 'sidebar', target: '[data-product-tour="sidebar-panel"]', title: '整理你的文件', content: '侧栏汇集最近文件、收藏和工作区。打开文件夹后，可以从文件树继续阅读。', placement: 'right', surface: 'sidebar' },
    { id: 'mode-switcher', target: '[data-product-tour="mode-switcher"]', title: '选择阅读方式', content: '按任务切换编辑、预览、分屏和对照阅读。切换模式不会改动文档正文。', placement: 'bottom', surface: 'preview' },
    { id: 'preview-edit', target: ['[data-product-tour="preview-area"] :is(h1,h2,p)', '[data-product-tour="preview-area"]'], title: '在预览中阅读和编辑', content: '预览里可阅读 Markdown；按 Alt + 左键可以定位并编辑对应内容。', placement: 'right', surface: 'preview' },
    { id: 'fullscreen', target: '[data-product-tour="fullscreen"]', title: '全屏专注阅读', content: '点击这里进入全屏模式，隐藏多余界面以专注阅读；也可以使用 F11 切换。', placement: 'bottom', surface: 'preview' },
    { id: 'ai-assistant', target: '[data-product-tour="ai-panel"]', title: '让 AI 协助阅读', content: '在右侧提问、解释或处理内容。也可以选中文本后通过右键菜单把选区带入对话。', placement: 'left', surface: 'ai-chat' },
    { id: 'reading-artifacts', target: '[data-product-tour="reading-artifact-center"]', title: '积累阅读成果', content: '桌面版会把人工高亮、批注和保存的 AI 成果汇集在这里；可按文档浏览、搜索和筛选。点击软件右下角的阅读成果入口，即可打开阅读成果面板。', placement: 'left', surface: 'artifacts', desktopOnly: true },
    { id: 'theme', target: '[data-product-tour="settings-appearance"]', title: '调整外观', content: '在通用设置的外观区域统一调整主题、光标、AI 头像、字号和全屏动效。桌面版还可通过提示词生成主题 JSON 并导入自定义主题。', placement: 'top', surface: 'settings-general' },
  ],
  files: [
    { id: 'file-entry', target: '[data-product-tour="open-file"]', title: '打开文件与目录', content: '打开 .md 文件开始阅读。桌面版可添加文件夹工作区；网页端目录能力取决于浏览器，单文件始终可用。', placement: 'right', surface: 'collapsed' },
    { id: 'file-navigation', target: '[data-product-tour="sidebar-panel"]', title: '最近、收藏与工作区', content: '侧栏按最近文件、收藏和工作区组织内容。常看的文档可以收藏，从文件树快速切换。', placement: 'right', surface: 'sidebar' },
    { id: 'reading-modes', target: '[data-product-tour="mode-switcher"]', title: '阅读与编辑模式', content: '编辑用于写作，预览用于阅读；分屏与对照模式适合比较内容。顶部标签可在多个文档间切换。', placement: 'bottom', surface: 'preview' },
    { id: 'preview-actions', target: ['[data-product-tour="preview-area"] :is(h1,h2,p)', '[data-product-tour="preview-area"]'], title: '预览中的操作', content: '预览支持目录、搜索与富内容阅读。按 Alt + 左键定位编辑；需要专注时，可使用右上角全屏按钮。', placement: 'right', surface: 'preview' },
    { id: 'fullscreen', target: '[data-product-tour="fullscreen"]', title: '全屏专注', content: '点击进入全屏阅读；按 F11 或顶部控制区退出。', placement: 'bottom', surface: 'preview' },
  ],
  fullscreen: [
    { id: 'fullscreen-controls', target: '[data-fullscreen-control-bar]', title: '隐藏式顶部控制条', content: '将鼠标移到屏幕顶部，控制条就会出现。这里可以切换阅读模式、打开 AI 助手、调整边距与主题，也可以退出全屏。', placement: 'bottom', surface: 'fullscreen' },
    { id: 'fullscreen-ai', target: '[data-fullscreen-ai-panel]', title: '随用随开的 AI 助手', content: '点击控制条中的「AI」打开小窗。拖动小窗顶部可调整位置，拖动右下角可调整大小；点击小窗外部即可关闭，即用即走。', placement: 'left', surface: 'fullscreen' },
    { id: 'fullscreen-padding', target: '#fullscreen-padding-card', title: '调整正文边距', content: '点击「边距」，拖动滑块调整正文左右留白，选择更适合自己的阅读宽度。', placement: 'bottom', surface: 'fullscreen' },
    { id: 'fullscreen-files', target: '[data-fullscreen-file-drawer]', title: '在全屏中切换文件', content: '点击「标签 / 文件」查看已打开的标签，并点击标签切换文档；文件侧栏还可从最近文件、收藏和工作区继续打开内容。标签栏右侧的「+」可新建或打开文件。', placement: 'right', surface: 'fullscreen' },
  ],
  annotations: [
    { id: 'mark-selection', target: ['[data-product-tour="preview-area"] :is(h1,h2,p)', '[data-product-tour="preview-area"]'], title: '选中文本，添加高亮', content: '在桌面版已打开的 Markdown 文件预览中选中文字，选择颜色即可保存高亮。下方是只读操作示意，不会写入文件或数据库。', placement: 'right', surface: 'preview', example: 'annotation', desktopOnly: true },
    { id: 'mark-note', target: ['[data-product-tour="preview-area"] :is(h1,h2,p)', '[data-product-tour="preview-area"]'], title: '写下文字批注', content: '在高亮工具栏中进入文字批注并提交。再次点击标记可以查看、修改颜色、编辑内容或删除。', placement: 'right', surface: 'preview', example: 'annotation', desktopOnly: true },
    { id: 'artifact-entry', target: '[data-product-tour="reading-artifact-center"]', title: '在阅读成果中回顾', content: '阅读成果汇总人工高亮与批注，也收纳你明确保存的 AI 摘要、问题集、AI 解读和阅读笔记。点击软件右下角的阅读成果入口，即可打开阅读成果面板；两类内容有独立标识。', placement: 'left', surface: 'artifacts', desktopOnly: true },
    { id: 'artifact-find', target: '[data-product-tour="reading-artifact-filters"]', title: '查找并返回原文', content: '切换“最近/按文档”，用搜索和类型筛选缩小范围；打开成果卡片可查看来源并定位原文。', placement: 'left', surface: 'artifacts', desktopOnly: true },
  ],
  ai: [
    { id: 'ai-entry', target: '[data-product-tour="ai-assistant"]', title: '打开 AI 助手', content: '点击软件右下角的 AI 入口，或使用 Ctrl + J 快捷键打开；选中文本后右键快捷提问，也能直接打开并带入上下文。', placement: 'top', surface: 'ai-chat' },
    { id: 'ai-chat', target: '[data-product-tour="ai-panel"]', title: '框选文本，一框一问', content: '框选正在阅读的文本，右键选择“添加到上下文”或“解释”等快捷预设，快速解答文档中的疑惑点；也可以在右侧 AI 面板补充问题或继续追问。', placement: 'left', surface: 'ai-chat' },
    { id: 'ai-save', target: ['[data-product-tour="ai-save"]', '[data-product-tour="ai-panel"]'], title: '保存 AI 阅读成果', content: '对 AI 回复满意后，将鼠标移到回复旁的保存按钮，可保存为摘要、问题集、AI 解读或阅读笔记；之后可从右下角阅读成果入口回顾。', placement: 'left', surface: 'ai-chat', desktopOnly: true },
    { id: 'ai-model', target: '[data-product-tour="ai-settings-content"]', title: '配置 AI 模型', content: '在“AI 模型”设置内容区配置对话服务、联网搜索和相关模型能力。桌面版还提供本地知识库能力；网页端不启用数据库、Embedding 和 RAG。', placement: 'top', surface: 'settings-ai' },
  ],
  appearance: [
    { id: 'theme-choose', target: '[data-product-tour="theme-picker"] .gm-theme-card', title: '选择主题', content: '内置暖色、浅色和深色主题，选择后立即应用到应用界面、编辑器与预览。', placement: 'top', surface: 'settings-general' },
    { id: 'theme-custom', target: '[data-product-tour="theme-manager-actions"]', title: '导入自定义主题', content: '桌面版有两个可替换的主题槽位。点击“添加主题”，复制提示词让 AI 生成主题 JSON，再粘贴、校验并导入；系统主题不可删除。', placement: 'top', surface: 'settings-general', desktopOnly: true },
    { id: 'appearance-more', target: '[data-product-tour="settings-appearance"]', title: '更多个性设置', content: '外观区域还可调整光标、AI 头像、内容字号和全屏动效；编辑器、快捷操作及快捷键在对应设置页中查看。', placement: 'top', surface: 'settings-general' },
  ],
}

export function getProductTourSteps(topic: ProductTourTopic, isWeb: boolean): ProductTourStep[] {
  return steps[topic].filter((step) => !isWeb || !step.desktopOnly)
}

export const PRODUCT_TOUR_DEMO_TAB_ID = 'guanmo-product-tour-demo'
export const PRODUCT_TOUR_DEMO_CONTENT = `# 欢迎使用观墨

观墨是一款专注 Markdown 阅读与创作的工具。

## 从这里开始

- 在预览区域按住 Alt 并左键点击，可定位到编辑器内容。
- 使用顶部模式切换，选择适合当前任务的阅读方式。
- 打开 AI 助手，获得解释、问答和内容处理帮助。
`
