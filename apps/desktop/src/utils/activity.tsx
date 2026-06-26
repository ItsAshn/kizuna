import { Gamepad2, Headphones, Film, Monitor, Activity } from 'lucide-react'
import type { UserActivity, UserActivityType } from '@kizuna/shared'

/** The verb shown before an activity name, e.g. "Playing Celeste". */
export function activityVerb(type: UserActivityType): string {
  switch (type) {
    case 'music':
      return 'Listening to'
    case 'game':
      return 'Playing'
    case 'video':
      return 'Watching'
    case 'app':
      return 'Using'
    default:
      return ''
  }
}

/** Lucide fallback icon for an activity type, used when no program icon exists. */
export function ActivityTypeIcon({ type, size = 11 }: { type: UserActivityType; size?: number }) {
  switch (type) {
    case 'game':
      return <Gamepad2 size={size} />
    case 'music':
      return <Headphones size={size} />
    case 'video':
      return <Film size={size} />
    case 'app':
      return <Monitor size={size} />
    default:
      return <Activity size={size} />
  }
}

/**
 * The activity's program icon (base64 data URI from the desktop detector) when
 * available, otherwise the lucide type icon. `size` controls the lucide fallback.
 */
export function ActivityIcon({
  activity,
  size = 11,
  className,
}: {
  activity: UserActivity
  size?: number
  className?: string
}) {
  if (activity.icon) {
    return <img className={className} src={activity.icon} alt="" />
  }
  return <ActivityTypeIcon type={activity.type} size={size} />
}

/** Plain-text summary, e.g. "Playing Celeste - Chapter 1". Useful for tooltips. */
export function activitySummary(activity: UserActivity): string {
  const verb = activityVerb(activity.type)
  const head = verb ? `${verb} ${activity.name}` : activity.name
  return activity.details ? `${head} - ${activity.details}` : head
}
