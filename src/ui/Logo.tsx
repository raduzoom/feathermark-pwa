/** The FeatherMark quill on glass (app icon concept A), drawn from the web boards. */
export function Logo(props: { size: number }) {
  return (
    <svg class="logo" aria-hidden="true" width={props.size} height={props.size} viewBox="0 0 100 100">
      <rect class="logo-bg" width="100" height="100" />
      <rect class="logo-page" x="20" y="16" width="56" height="68" rx="10" />
      <path class="logo-quill" d="M78 14 C54 22 36 46 34 78 C54 72 74 48 78 14 Z" />
      <path class="logo-shaft" d="M26 88 Q50 54 78 14" />
    </svg>
  )
}
