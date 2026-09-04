import { appearanceRegistry } from '@/services/appearance/appearanceRegistry'
import type { ThemeId } from '@/services/appearance/appearanceSchema'
import './theme-picker.css'

const THEME_OPTIONS = appearanceRegistry.builtInThemes

export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemeId
  onChange: (value: ThemeId) => void
}) {
  return (
    <div className="gm-theme-picker" role="radiogroup" aria-label="主题">
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          className="gm-theme-card"
          data-preview-theme={option.id}
          data-active={value === option.id}
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
        >
          <span className="gm-theme-card__preview" aria-hidden="true">
            <span className="gm-theme-card__surface">
              <span className="gm-theme-card__heading" />
              <span className="gm-theme-card__line" />
              <span className="gm-theme-card__line gm-theme-card__line--short" />
              <span className="gm-theme-card__accent" />
            </span>
          </span>
          <span className="gm-theme-card__label">{option.label}</span>
          <span className="gm-theme-card__description">{option.description}</span>
        </button>
      ))}
    </div>
  )
}
