import pinsu from '../assets/pinsu.jpg'

/** Pinsu's actual photo, framed round. The source is EXIF-oriented (browsers
 * honor it by default); object-position frames the face. Used in the header
 * avatar, the litter status ring, and the login screen. */
export default function PinsuAvatar({ className = '' }: { className?: string }) {
  return (
    <img
      className={`pinsu-photo ${className}`.trim()}
      src={pinsu}
      alt="Pinsu"
      draggable={false}
    />
  )
}
