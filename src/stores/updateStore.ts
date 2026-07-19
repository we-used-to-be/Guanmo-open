import { create } from 'zustand'
import type { ReleaseDetails } from '@/services/updateService'

interface UpdateState {
  selectedRelease: ReleaseDetails | null
  showDetails: (release: ReleaseDetails) => void
  closeDetails: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  selectedRelease: null,
  showDetails: (selectedRelease) => set({ selectedRelease }),
  closeDetails: () => set({ selectedRelease: null }),
}))
