import pinsu from '../assets/pinsu.jpg'

/** Chutku's actual photo, framed round. Sources are EXIF-oriented (browsers
 * honor it by default); object-position frames the face. Used in the litter
 * status ring (default photo) and the login screen (its own face-crop via
 * the `src` override). */
export default function ChutkuAvatar({
  className = '',
  src = pinsu,
}: {
  className?: string
  src?: string
}) {
  return (
    <img
      className={`pinsu-photo ${className}`.trim()}
      src={src}
      alt="Chutku"
      draggable={false}
    />
  )
}
