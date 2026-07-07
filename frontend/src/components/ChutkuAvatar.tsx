import pinsu from '../assets/pinsu.jpg'

/** Chutku's actual photo, framed round. Sources are EXIF-oriented (browsers
 * honor it by default); object-position frames the face. Used in the litter
 * status ring (default photo), the login screen (its own face-crop via the
 * `src` override), and the Food Machine ring (machine photo + alt). */
export default function ChutkuAvatar({
  className = '',
  src = pinsu,
  alt = 'Chutku',
}: {
  className?: string
  src?: string
  alt?: string
}) {
  return (
    <img
      className={`pinsu-photo ${className}`.trim()}
      src={src}
      alt={alt}
      draggable={false}
    />
  )
}
