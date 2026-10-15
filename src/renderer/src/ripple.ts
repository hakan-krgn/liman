/** Elements that answer a click with a ripple from the pointer position. */
const TARGETS = '.btn, .icon-btn, .host-row, .tab, .group-label, .menu button, .update-notice, .segmented button, .sftp-row'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')

/** Adds a short ripple to clickable elements; styles live in styles.css (.ripple). */
export function installRipple(): void {
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || reducedMotion.matches) return
      const el = (e.target as Element | null)?.closest<HTMLElement>(TARGETS)
      if (!el || el.matches(':disabled') || el.querySelector(':scope > input')) return
      const r = el.getBoundingClientRect()
      const size = Math.hypot(r.width, r.height) * 2
      const host = document.createElement('span')
      host.className = 'ripple-host'
      const dot = document.createElement('span')
      dot.className = 'ripple'
      dot.style.width = dot.style.height = `${size}px`
      dot.style.left = `${e.clientX - r.left - size / 2}px`
      dot.style.top = `${e.clientY - r.top - size / 2}px`
      host.appendChild(dot)
      el.appendChild(host)
      dot.addEventListener('animationend', () => host.remove(), { once: true })
    },
    { capture: true, passive: true }
  )
}
