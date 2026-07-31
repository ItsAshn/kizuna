import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import './Select.css'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode
  error?: string
}

/**
 * Select styled to sit next to Input in the same form row. The native control
 * is unstyleable on some engines (WebKitGTK renders it with the GTK theme, not
 * ours), so appearance is reset and the chevron is drawn by CSS — see
 * Select.css.
 */
const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, error, id, className = '', children, ...props },
  ref,
) {
  const autoId = useId()
  const selectId = id ?? autoId
  const errorId = `${selectId}-error`

  return (
    <div className={`ui-field${error ? ' ui-field--error' : ''}`}>
      {label && (
        <label className="ui-field__label" htmlFor={selectId}>
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        className={`select-field ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      >
        {children}
      </select>
      {error && (
        <span className="ui-field__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  )
})

export default Select
