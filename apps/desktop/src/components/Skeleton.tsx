import './Skeleton.css'

interface SkeletonProps {
  width?: string | number
  height?: string | number
  variant?: 'text' | 'circle' | 'rect'
  lines?: number
  fullWidth?: boolean
}

export default function Skeleton({ width, height, variant = 'rect', lines = 1, fullWidth = false }: SkeletonProps) {
  if (variant === 'text' && lines > 1) {
    return (
      <div className="skeleton-text-block" role="status" aria-label="Loading" aria-busy="true">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className={`skeleton skeleton--text ${i === lines - 1 ? 'skeleton--text-last' : ''}`}
            style={{ width: i === lines - 1 ? '60%' : fullWidth ? '100%' : undefined }}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className={`skeleton skeleton--${variant}`}
      role="status"
      aria-label="Loading"
      aria-busy="true"
      style={{
        width: width ?? (variant === 'circle' ? '40px' : fullWidth ? '100%' : '200px'),
        height: height ?? (variant === 'circle' ? '40px' : variant === 'text' ? '14px' : '20px'),
      }}
    />
  )
}
