import Modal from './ui/Modal'
import './MediaGallery.css'

interface Props {
  images: { url: string; filename: string }[]
  onOpen: (index: number) => void
  onClose: () => void
}

export default function MediaGallery({ images, onOpen, onClose }: Props) {
  return (
    <Modal open title={`Media (${images.length})`} onClose={onClose}>
      {images.length === 0 ? (
        <div className="media-gallery__empty">No images or videos in this channel yet.</div>
      ) : (
        <div className="media-gallery__grid">
          {images.map((img, i) => (
            <button
              key={img.url}
              className="media-gallery__item"
              onClick={() => { onClose(); onOpen(i) }}
              aria-label={img.filename}
            >
              {/\.(mp4|webm|ogg)$/i.test(img.url) ? (
                <video src={img.url} className="media-gallery__media" muted preload="metadata" />
              ) : (
                <img src={img.url} alt={img.filename} className="media-gallery__media" loading="lazy" />
              )}
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
