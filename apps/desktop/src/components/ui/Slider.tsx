import { forwardRef, type InputHTMLAttributes } from 'react'
import './Slider.css'

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type' | 'size'> {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  size?: 'sm' | 'md'
  /** Fill the track with the brand color from the start up to the thumb. */
  fillFromStart?: boolean
  ariaLabel?: string
}

const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    onChange,
    min = 0,
    max = 100,
    step = 1,
    size = 'md',
    fillFromStart = false,
    ariaLabel,
    className = '',
    style,
    disabled,
    ...props
  },
  ref
) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
  const fillStyle = fillFromStart
    ? {
        background: `linear-gradient(to right, var(--brand) 0%, var(--brand) ${pct}%, var(--bg-tertiary) ${pct}%, var(--bg-tertiary) 100%)`,
      }
    : undefined

  const classes = ['slider', size === 'sm' && 'slider--sm', className].filter(Boolean).join(' ')

  return (
    <input
      ref={ref}
      type="range"
      className={classes}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...fillStyle, ...style }}
      {...props}
    />
  )
})

export default Slider
