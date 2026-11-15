// A menu button and its popup (WAI-ARIA menu button pattern): arrows move, Enter or Space picks, Escape closes and
// returns focus. Items are built when the menu opens, and again on every render while open.
import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

export type MenuItem =
  | { label: string; onSelect?: () => void; kind?: 'item' | 'checkbox' | 'radio'; checked?: boolean; depth?: number; danger?: boolean; disabled?: boolean; icon?: ComponentChildren; submenu?: () => MenuItem[] }
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
    if (open) firstItem(menu.current)?.focus()
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
        <MenuList
          menuRef={menu}
          label={props.ariaLabel}
          items={items}
          onClose={close}
          onSubmenu={(f) => setSub(() => f)}
        />
      )}
    </span>
  )
}

export const firstItem = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[role^="menuitem"]') ?? null

/** A menu's popup (role menu): arrows move, Enter or Space picks, Escape closes (refocus true), Tab leaves. Used by
 *  MenuButton and by context menus. Focus its first item when it opens. */
export function MenuList({ menuRef, label, items, onClose, onSubmenu, class: cls }: {
  menuRef: RefObject<HTMLDivElement | null>
  label: string
  items: MenuItem[]
  onClose: (refocus: boolean) => void
  onSubmenu?: (items: () => MenuItem[]) => void
  class?: string
}) {
  const pick = (item: Exclude<MenuItem, 'separator'>) => {
    // a disabled item can be reached with the arrows but does nothing
    if (item.disabled) return
    if (item.submenu) return onSubmenu?.(item.submenu)
    if (item.kind !== 'checkbox') onClose(true)
    item.onSelect?.()
  }
  const onKey = (e: KeyboardEvent) => {
    const all = [...((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown') all[(i + 1) % all.length]?.focus()
    else if (e.key === 'ArrowUp') all[(i - 1 + all.length) % all.length]?.focus()
    else if (e.key === 'Home') all[0]?.focus()
    else if (e.key === 'End') all[all.length - 1]?.focus()
    else if (e.key === 'Escape') onClose(true)
    else if (e.key === 'Tab') onClose(false)
    else return
    if (e.key !== 'Tab') e.preventDefault()
    e.stopPropagation()
  }
  // one leading 16 px column for the whole menu when any item has a box, a dot or an icon, so every label lines up
  const lead = items.some((i) => i !== 'separator' && (i.kind === 'checkbox' || i.kind === 'radio' || i.icon))
  return (
    <div ref={menuRef} role="menu" aria-label={label} class={cls ?? 'menu'} onKeyDown={onKey}>
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={`s${i}`} role="separator" class="menu-separator" />
        ) : (
          <div
            key={item.label + i}
            role={ROLE[item.kind ?? 'item']}
            aria-checked={item.kind && item.kind !== 'item' ? Boolean(item.checked) : undefined}
            aria-disabled={item.disabled ? 'true' : undefined}
            tabIndex={-1}
            class="menu-item"
            data-depth={item.depth ?? 0}
            data-danger={item.danger ? 'true' : undefined}
            // a click leaves the page's selection alone (a selection in the note stays for the next command)
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                pick(item)
              }
            }}
          >
            {lead && (
              <span class="menu-lead" aria-hidden="true">
                {item.kind === 'checkbox' ? (
                  <span class="menu-box" data-checked={item.checked ? 'true' : 'false'}>
                    {item.checked && (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="m2.5 6.2 2.3 2.3 4.7-4.9" />
                      </svg>
                    )}
                  </span>
                ) : item.kind === 'radio' ? (
                  <span class="menu-radio" data-checked={item.checked ? 'true' : 'false'} />
                ) : (
                  item.icon
                )}
              </span>
            )}
            <span class="menu-label">{item.label}</span>
          </div>
        ),
      )}
    </div>
  )
}
