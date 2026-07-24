/**
 * 特性介绍内容定义。
 * 软件总体介绍和按版本号的新特性图文内容。
 *
 * 图片规格：
 * - 格式：PNG（推荐截图）或 SVG（推荐插图）
 * - 建议尺寸：560×200px（宽高比约 5:2），图片区域最大高度 220px
 * - 存放位置：src/assets/feature-intro/
 * - 文件命名：feature-{序号}-{英文简名}.png
 */

import immersiveImg from '@/assets/feature-intro/feature-1-immersive.png'
import markdownImg from '@/assets/feature-intro/feature-2-markdown.png'
import aiImg from '@/assets/feature-intro/feature-3-ai.png'
import opensourceImg from '@/assets/feature-intro/feature-6-opensource.png'

export interface FeatureIntroItem {
  /** 特性标题 */
  title: string
  /** 特性描述 */
  description: string
  /** 可选插图（SVG 字符串或图片 URL） */
  image?: string
}

export interface FeatureIntroVersion {
  /** 版本号，如 "1.0.0" */
  version: string
  /** 该版本的新特性列表 */
  features: FeatureIntroItem[]
}

/** 软件总体介绍 */
export const OVERVIEW_FEATURES: FeatureIntroItem[] = [
  {
    title: '沉浸式工作体验',
    description: '专注内容，让阅读与创作更加自然。全屏沉浸模式与无缝编辑体验，打造属于你的专注工作空间。',
    image: immersiveImg,
  },
  {
    title: 'Markdown 原生体验',
    description: '从编辑到阅读，提供完整 Markdown 工作流。支持实时预览、预览内编辑（Alt+左键）、分屏阅读、Diff 对比，以及丰富内容渲染。',
    image: markdownImg,
  },
  {
    title: 'AI 辅助阅读',
    description: '让 AI 成为你的知识助手。支持选区解释、上下文问答、文档总结、智能内容辅助，以及右键菜单快捷预设，一键调用常用 AI 指令。',
    image: aiImg,
  },
  {
    title: '私人知识库',
    description: '构建属于你的 AI 知识空间。基于本地文档与 RAG 技术，让 AI 更懂你的知识。',
  },
  {
    title: '流畅性能体验',
    description: '为大型文档与复杂工作场景持续优化。优化启动速度、渲染性能与资源管理，让使用始终保持流畅。',
  },
  {
    title: '开源 · 本地优先',
    description: '你的知识，由你掌控。开源透明，本地存储，支持自主选择 AI 服务，重视数据隐私。',
    image: opensourceImg,
  },
]

/** 各版本新特性 */
export const VERSION_FEATURES: FeatureIntroVersion[] = [
  // 后续版本在此添加
  // {
  //   version: '1.1.0',
  //   features: [
  //     {
  //       title: '新特性示例',
  //       description: '这是新版本特性的描述。',
  //     },
  //   ],
  // },
]

/**
 * 查找指定版本的新特性内容。
 * 返回 undefined 表示该版本没有图文内容，应走 GitHub 兜底。
 */
export function getVersionFeatures(version: string): FeatureIntroItem[] | undefined {
  const entry = VERSION_FEATURES.find((v) => v.version === version)
  return entry?.features
}