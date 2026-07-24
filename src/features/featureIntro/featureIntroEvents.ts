/**
 * 特性介绍弹窗事件。
 */

export const OPEN_FEATURE_INTRO_EVENT = 'guanmo:open-feature-intro'

export interface FeatureIntroEventDetail {
  /** 'overview' 为软件总体介绍，'version' 为新版本特性 */
  mode: 'overview' | 'version'
  /** mode 为 'version' 时指定版本号 */
  version?: string
}

export function openFeatureIntro(detail: FeatureIntroEventDetail): void {
  window.dispatchEvent(
    new CustomEvent<FeatureIntroEventDetail>(OPEN_FEATURE_INTRO_EVENT, {
      detail,
    }),
  )
}