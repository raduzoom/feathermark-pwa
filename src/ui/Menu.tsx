// A menu button and its popup (WAI-ARIA menu button pattern): arrows move, Enter or Space picks, Escape closes and
// returns focus. Items are built when the menu opens, and again on every render while open.
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

export type MenuItem =
  | { label: string; onSelect?: () => void; kind?: 'item' | 'checkbox' | 'radio'; checked?: boolean; depth?: number; danger?: boolean; submenu?: () => MenuItem[] }
  | 'separator'

const ROLE = { item: 'menuitem', checkbox: 'menuitemcheckbox', radio: 'menuitemradio' } as const

export function MenuButton(props: { label: ComponentChildren; ariaLabel: string; items: () => MenuItem[]; class?: string; pressed?: boolean }) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<(() => MenuItem[]) | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const close = (refocus: boolean) => {
    setOpen(false)
    setSub(null)
    if (refocus) button.current?.focus()
  }

  useLayoutEffect(() => {
    if (open) (menu.current?.querySelector('[role^="menuitem"]') as HTMLElement | null)?.focus()
  }, [open, sub])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  const items = open ? (sub ?? props.items)() : []
  const pick = (item: Exclude<MenuItem, 'separator'>) => {
    if (item.submenu) return setSub(() => item.submenu!)
    const keepOpen = item.kind === 'checkbox'
    if (!keepOpen) close(true)
    item.onSelect?.()
  }

  const onKey = (e: KeyboardEvent) => {
    const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus()
    else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus()
    else if (e.key === 'Home') all[0]?.focus()
    else if (e.key === 'End') all[all.length - 1]?.focus()
    else if (e.key === 'Escape') close(true)
    else if (e.key === 'Tab') close(false)
    else return
    if (e.key !== 'Tab') e.preventDefault()
    e.stopPropagation()
  }

  return (
    <span class="menu-anchor">
      <button
        ref={button}
        type="button"
        class={props.class ?? 'menu-trigger'}
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={props.pressed}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {props.label}
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={props.ariaLabel} class="menu" onKeyDown={onKey}>
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={`s${i}`} role="separator" class="menu-separator" />
            ) : (
              <div
                key={item.label + i}
                role={ROLE[item.kind ?? 'item']}
                aria-checked={item.kind && item.kind !== 'item' ? Boolean(item.checked) : undefined}
                tabIndex={-1}
                class="menu-item"
                data-depth={item.depth ?? 0}
                data-danger={item.danger ? 'true' : undefined}
                onClick={() => pick(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pick(item)
                  }
                }}
              >
                {item.kind === 'checkbox' || item.kind === 'radio' ? <span class="menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span> : null}
                {item.label}
              </div>
            ),
          )}
        </div>
      )}
    </span>
  )
}
