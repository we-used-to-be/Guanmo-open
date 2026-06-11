export function describeFileOperationError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  if (
    lower.includes('already exists') ||
    lower.includes('os error 183') ||
    message.includes('已存在') ||
    message.includes('当文件已存在')
  ) {
    return '同一文件夹下已存在同名文件或文件夹'
  }
  if (
    lower.includes('not found') ||
    lower.includes('os error 2') ||
    message.includes('找不到') ||
    message.includes('不存在')
  ) {
    return '原文件不存在，请刷新工作区后重试'
  }
  if (
    lower.includes('access is denied') ||
    lower.includes('permission') ||
    lower.includes('os error 5') ||
    message.includes('拒绝访问') ||
    message.includes('权限')
  ) {
    return '没有权限完成该文件操作'
  }
  if (lower.includes('extension is not allowed')) {
    return '只支持操作允许的文本或图片文件扩展名'
  }
  return message ? `${fallback}: ${message}` : fallback
}
