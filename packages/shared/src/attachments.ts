/**
 * Attachment upload contract, shared between the server's validation and the
 * client's file picker.
 *
 * Kept in its own module (rather than the package barrel) so the server can
 * import it without pulling in the browser-only code that lives alongside it.
 */

/**
 * File extensions the server accepts as attachments. The upload route validates
 * both the extension and the file's magic bytes against this list, so the
 * picker's `accept` attribute must mirror it exactly — a wildcard like
 * `image/*` offers files (.bmp, .tiff, .avi) that upload and are then rejected,
 * which reads as a broken upload rather than an unsupported format.
 */
export const ALLOWED_ATTACHMENT_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.webm',
  '.mp3',
  '.ogg',
  '.wav',
  '.pdf',
  '.txt',
  '.json',
] as const

/** Ready-made `accept` value for a file input, derived from the allowlist. */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.join(',')
