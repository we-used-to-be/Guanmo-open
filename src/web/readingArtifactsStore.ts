import { UnsupportedCapabilityError } from './externalHttp'

interface WebReadingArtifactsState {
  saveArtifactFromMessage: () => Promise<never>
}

const state: WebReadingArtifactsState = {
  saveArtifactFromMessage: async () => {
    throw new UnsupportedCapabilityError('阅读成果与批注')
  },
}

export function useReadingArtifactsStore<T>(selector: (value: WebReadingArtifactsState) => T): T {
  return selector(state)
}
