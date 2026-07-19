import { useToastStore, type ToastOptions } from '@/stores/toastStore'

function show(message: string, type: NonNullable<ToastOptions['type']>) {
  return useToastStore.getState().addToast({ message, type })
}

export const toast = {
  success: (message: string) => show(message, 'success'),
  info: (message: string) => show(message, 'info'),
  warning: (message: string) => show(message, 'warning'),
  error: (message: string) => show(message, 'error'),
  show: (options: ToastOptions) => useToastStore.getState().addToast(options),
  dismiss: (id: string) => useToastStore.getState().removeToast(id),
}
