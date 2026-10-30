import { saveFileDialog, writeFile } from '@/hooks/useTauri'

export async function exportPreviewSelectionDiagnostics(report: string): Promise<boolean> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = await saveFileDialog(`guanmo-selection-${stamp}.md`)
  if (!path) return false
  await writeFile(path, `# 观墨预览选区诊断\n\n仅包含事件、数值位置与固定来源码，不含正文、文件路径、凭据或原始堆栈。\n\n\`\`\`json\n${report}\n\`\`\`\n`)
  return true
}
