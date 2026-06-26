import { useState } from 'react'
import type { UserStatus } from '@kizuna/shared'
import './Avatar.css'

interface AvatarProps {
  /** Avatar image URL. Falls back to the first initial of `name` when absent or it fails to load. */
  src?: string | null
  /** Display name; its first character is used for the fallback initial. */
  name?: string | null
  /** Diameter in pixels. Default 32 (sidebar/member). Chat = 36, profile card = 64. */
  size?: number
  /** When set, draws a colored presence ring around the avatar. */
  status?: UserStatus | null
  /** `status_sticker_id` — when set (with `serverUrl`) renders the animated sticker badge. */
  stickerId?: string | null
  /** Server base URL, needed to build the gif thumb/file endpoints. */
  serverUrl?: string | null
  /** Background color behind the image / initial (e.g. a role color). */
  bgColor?: string
  /** Adds a surface-colored separator border (used over the profile-card banner). */
  frame?: boolean
  className?: string
}

/**
 * Canonical user avatar: image-or-initial fallback, optional presence ring, and
 * an animated sticker-status badge that shows a static first frame at rest and
 * plays on hover (driven from the wrapper so the badge can stay click-through).
 */
export default function Avatar({
  src,
  name,
  size = 32,
  status,
  stickerId,
  serverUrl,
  bgColor,
  frame,
  className,
}: AvatarProps) {
  const [hovered, setHovered] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const [thumbBroken, setThumbBroken] = useState(false)
  const [fileBroken, setFileBroken] = useState(false)

  const initial = name?.trim()?.[0]?.toUpperCase() || '?'
  const showImg = !!src && !imgFailed

  // Sticker badge: a static first frame (`/thumb`) at rest, with the animated
  // `/file` mounted as an overlay only while hovered so it always replays from
  // frame 0. Falls back gracefully (thumb→file→nothing) without ever mutating
  // the DOM, so a failed load can't permanently hide the badge.
  const thumbUrl = `${serverUrl}/api/gifs/${stickerId}/thumb`
  const fileUrl = `${serverUrl}/api/gifs/${stickerId}/file`
  const restingSrc = thumbBroken ? fileUrl : thumbUrl
  const showSticker = !!stickerId && !!serverUrl && !(thumbBroken && fileBroken)

  const classes = [
    'avatar',
    status && `avatar--status-${status}`,
    frame && 'avatar--frame',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      style={{ '--avatar-size': `${size}px`, background: bgColor } as React.CSSProperties}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {showImg ? (
        <img src={src!} alt="" className="avatar__img" onError={() => setImgFailed(true)} />
      ) : (
        <span className="avatar__initial">{initial}</span>
      )}
      {showSticker && (
        <span className="avatar__sticker">
          <img
            src={restingSrc}
            alt=""
            className="avatar__sticker-img"
            onError={() => (thumbBroken ? setFileBroken(true) : setThumbBroken(true))}
          />
          {hovered && !fileBroken && (
            <img
              src={fileUrl}
              alt=""
              className="avatar__sticker-img avatar__sticker-img--anim"
              onError={() => setFileBroken(true)}
            />
          )}
        </span>
      )}
    </div>
  )
}
