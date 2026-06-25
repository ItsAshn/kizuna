import { forwardRef, useId, type ReactNode, type TextareaHTMLAttributes } from 'react'
import './Input.css'

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode
  error?: string
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, error, id, className = '', ...props },
  ref
) {
  const autoId = useId()
  const textareaId = id ?? autoId
  const errorId = `${textareaId}-error`

  return (
    <div className={`ui-field${error ? ' ui-field--error' : ''}`}>
      {label && (
        <label className="ui-field__label" htmlFor={textareaId}>
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={textareaId}
        className={`input-field ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...props}
      />
      {error && (
        <span className="ui-field__error" id={errorId}>
          {error}
        </span>
      )}
    </div>
  )
})

export default Textarea
