export const OPEN_AI_CHAT_EVENT = 'guanmo:open-ai-chat'
export const TOGGLE_AI_CHAT_EVENT = 'guanmo:toggle-ai-chat'
export const OPEN_READING_ARTIFACTS_EVENT = 'guanmo:open-reading-artifacts'
export const TOGGLE_READING_ARTIFACTS_EVENT = 'guanmo:toggle-reading-artifacts'
export const OPEN_READING_REMINDERS_EVENT = 'guanmo:open-reading-reminders'
export const TOGGLE_READING_REMINDERS_EVENT = 'guanmo:toggle-reading-reminders'

export type AiPanelView = 'chat' | 'artifacts' | 'reminders'
let currentPanelView: AiPanelView = 'chat'

export function reportAiPanelView(view: AiPanelView) { currentPanelView = view }
export function getAiPanelView(): AiPanelView { return currentPanelView }

export type AiPanelNavigation = {
  mode: 'open' | 'toggle'
  view: AiPanelView
  artifactKey?: string
}

let pendingPanelNavigation: AiPanelNavigation | null = null

function requestPanelNavigation(eventName: string, navigation: AiPanelNavigation) {
  pendingPanelNavigation = navigation
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      if (pendingPanelNavigation === navigation) {
        window.dispatchEvent(new Event(eventName))
      }
    }, 0)
  }
}

export function consumePendingPanelNavigation() {
  const navigation = pendingPanelNavigation
  pendingPanelNavigation = null
  return navigation
}

export function requestOpenAiChat() {
  requestPanelNavigation(OPEN_AI_CHAT_EVENT, { mode: 'open', view: 'chat' })
}

export function requestToggleAiChat() {
  requestPanelNavigation(TOGGLE_AI_CHAT_EVENT, { mode: 'toggle', view: 'chat' })
}

export function requestOpenReadingArtifacts() {
  requestPanelNavigation(OPEN_READING_ARTIFACTS_EVENT, { mode: 'open', view: 'artifacts' })
}

export function requestOpenReadingReminders() {
  requestPanelNavigation(OPEN_READING_REMINDERS_EVENT, { mode: 'open', view: 'reminders' })
}

export function requestToggleReadingReminders() {
  requestPanelNavigation(TOGGLE_READING_REMINDERS_EVENT, { mode: 'toggle', view: 'reminders' })
}

export function requestOpenReadingArtifact(key: string) {
  requestPanelNavigation(OPEN_READING_ARTIFACTS_EVENT, { mode: 'open', view: 'artifacts', artifactKey: key })
}

export function requestToggleReadingArtifacts() {
  requestPanelNavigation(TOGGLE_READING_ARTIFACTS_EVENT, { mode: 'toggle', view: 'artifacts' })
}
