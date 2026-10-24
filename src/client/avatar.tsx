/**
 * Round Feishu avatar: the user or chat image when Feishu returned one,
 * otherwise (and when the image fails to load) the first character of the
 * display text.
 *
 * @module dsh-channels/client/avatar
 */

import { useEffect, useState } from 'react'

/**
 * One avatar badge. Decorative: the adjacent label names the user or chat.
 * @param props - `text` supplies the fallback initial, `url` the image, `size` the diameter in px (default 26).
 * @returns the badge.
 */
export function Avatar(props: { text: string; url?: string; size?: number }): JSX.Element {
  const { text, url, size = 26 } = props
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [url])
  const style = { width: size, height: size, fontSize: Math.round(size * 0.46) }
  if (url !== undefined && !failed) {
    return (
      <img
        className="dsh-channels-avatar"
        style={style}
        src={url}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
  }
  return <span className="dsh-channels-avatar" style={style} aria-hidden="true">{Array.from(text)[0] ?? '?'}</span>
}
