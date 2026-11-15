// 16 px line icons from the shell canvas (universal/design/handoff/screens/web-shell-redesign.dc.html). Decorative:
// every control that shows one also has a text label. Coloured through `currentColor`.
const PATHS = {
  pin: <path d="M6 2h4l-.5 4.5L12 9H4l2.5-2.5zM8 9v5" />,
  tag: (
    <>
      <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
      <circle cx="5.5" cy="5.5" r=".8" />
    </>
  ),
  move: <path d="M2 4h4l1.5 2H14v7H2zM7 9.5h4M9.5 8l1.5 1.5L9.5 11" />,
  download: <path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9" />,
  chevron: <path d="m6 4 4 4-4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" class="icon" width={size} height={size} viewBox="0 0 16 16">
      {PATHS[name]}
    </svg>
  )
}

/** The three dots of "More". Filled, not stroked. */
export function DotsIcon() {
  return (
    <svg aria-hidden="true" class="icon-dots" width="16" height="16" viewBox="0 0 16 16">
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="13" cy="8" r="1.3" />
    </svg>
  )
}
