import ToggleSwitch from '../ui/ToggleSwitch'
import Slider from '../ui/Slider'

export function SettingsToggleRow({
  label,
  hint,
  checked,
  onChange,
  ariaLabel,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
}) {
  return (
    <div className="settings-toggle-row">
      <div>
        <div className="settings-toggle-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={ariaLabel} />
    </div>
  )
}

export function SettingsSlider({
  label,
  min,
  max,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    // Grid, not flex: the label column is a fixed width so every slider in the
    // panel starts its track at the same x, and the hint lines up under it.
    <div className="settings-slider-control">
      <span className="settings-slider-label">{label}</span>
      <Slider
        min={min}
        max={max}
        value={value}
        onChange={onChange}
        fillFromStart
        disabled={disabled}
        ariaLabel={label}
      />
      <span className="settings-slider-value">{value}%</span>
      {hint && <div className="settings-hint settings-slider-hint">{hint}</div>}
    </div>
  )
}

export function SettingsActionRow({
  label,
  hint,
  buttonLabel,
  onClick,
  danger,
  dangerConfirm,
  onCancel,
}: {
  label: string
  hint?: string
  buttonLabel: string
  onClick: () => void
  danger?: boolean
  dangerConfirm?: boolean
  onCancel?: () => void
}) {
  let btnClass = 'settings-btn'
  if (dangerConfirm) btnClass += ' settings-btn--danger-confirm'
  else if (danger) btnClass += ' settings-btn--danger'

  return (
    <div className="settings-action-row">
      <div>
        <div className="settings-toggle-label">{label}</div>
        {hint && <div className="settings-hint">{hint}</div>}
      </div>
      <div className="settings-action-buttons">
        {dangerConfirm ? (
          <>
            <button onClick={onClick} className={btnClass}>
              confirm
            </button>
            <button onClick={onCancel} className="settings-btn">
              cancel
            </button>
          </>
        ) : (
          <button onClick={onClick} className={btnClass}>
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  )
}
