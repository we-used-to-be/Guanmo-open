/**
 * Settings navigation utilities.
 */

export const OPEN_SETTINGS_SECTION_EVENT = 'guanmo:open-settings-section'

export function openSettingsSection(section: string): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section } }),
  )
}
