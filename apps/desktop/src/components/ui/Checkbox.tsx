import './Checkbox.css'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
  ariaLabel?: string
}

export default function Checkbox({ checked, onChange, disabled = false, label, ariaLabel }: CheckboxProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onChange(!checked)
    }
  }

  return (
    <label
      className={`checkbox${disabled ? ' checkbox--disabled' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel || label}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={handleKeyDown}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        tabIndex={-1}
      />
      <span className="checkbox__box">
        {checked && (
          <svg className="checkbox__check" viewBox="0 0 12 12" fill="none">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {label && <span className="checkbox__label">{label}</span>}
    </label>
  )
}
