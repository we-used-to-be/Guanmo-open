export interface ManualUpdateCheckFeedback { tone: 'success' | 'error' | 'info'; message: string }
export async function runManualUpdateCheck(): Promise<ManualUpdateCheckFeedback> { return { tone: 'info', message: 'Web 端不支持自动更新，请访问项目页面下载最新版本。' } }
export async function runAutomaticUpdateCheck(): Promise<void> {}
