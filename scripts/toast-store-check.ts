import { useToastStore } from '../src/stores/toastStore'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

const firstId = useToastStore.getState().addToast({
  id: 'dedup-toast',
  title: '标题',
  message: '正文',
  duration: null,
  actions: [{ label: '操作', onClick: () => {} }],
})
const duplicateId = useToastStore.getState().addToast({
  id: 'dedup-toast',
  message: '不应覆盖',
})
const deduped = useToastStore.getState().toasts
assert(firstId === duplicateId, '相同 id 应返回已有 Toast')
assert(deduped.length === 1, '相同 id 不应重复显示')
assert(deduped[0].title === '标题' && deduped[0].actions.length === 1, '标题与操作按钮应保留')

useToastStore.getState().addToast({ id: 'paused-toast', message: '暂停测试', duration: 30 })
useToastStore.getState().pauseToast('paused-toast')
await new Promise((resolve) => setTimeout(resolve, 50))
assert(useToastStore.getState().toasts.some((item) => item.id === 'paused-toast'), '悬停暂停后不应自动关闭')
useToastStore.getState().resumeToast('paused-toast')
await new Promise((resolve) => setTimeout(resolve, 50))
assert(!useToastStore.getState().toasts.some((item) => item.id === 'paused-toast'), '恢复倒计时后应自动关闭')

useToastStore.getState().removeToast('dedup-toast')
console.info('Toast store checks passed')
