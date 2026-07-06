import pinsu from '../assets/pinsu.jpg'

/** Pinsu's actual photo, framed round. Sources are EXIF-oriented (browsers
 * honor it by default); object-position frames the face. Used in the litter
 * status ring (default photo) and the login screen (its own face-crop via
 * the `src` override). */
export default function PinsuAvatar({
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
      alt="Pinsu"
      draggable={false}
    />
  )
}
