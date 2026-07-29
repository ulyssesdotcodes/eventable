// Draggable split between two panes. The sized pane's extent is persisted as a
// fraction of the shared container so the split stays proportional across
// resizes; drags set pixels live, and the fraction is saved on release.
//
// Only the flex *basis* is set, never the grow/shrink: the other pane may want
// to be content-sized (the timeline pane is), and something has to take the
// slack — the sized pane does, since it is the one with a stylesheet grow.
//
// One component, two axes: `axis` is the container's flex direction, so a
// 'column' container (the timeline/editor stack above the table pane) drags
// vertically and a 'row' container (canvas beside the side panels) drags
// horizontally. The sized pane is always the container's LAST child, so both
// measure from the container's far edge.

import { onCleanup, onMount } from 'solid-js'

const MIN_PANE_PX = 80

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function PaneDivider(props: {
  container: () => HTMLElement | undefined
  // The pane whose size the drag sets — the container's last child.
  pane: () => HTMLElement | undefined
  axis?: 'row' | 'column'
  get: () => number
  set: (fraction: number) => void
  label?: string
}) {
  let dividerEl: HTMLDivElement | undefined
  let dragging = false
  const horizontal = (): boolean => props.axis === 'row'
  const extent = (el: HTMLElement): number => {
    const r = el.getBoundingClientRect()
    return horizontal() ? r.width : r.height
  }

  function applyFraction(fraction: number) {
    const container = props.container()
    const pane = props.pane()
    if (!container || !pane) return
    const total = extent(container)
    pane.style.flexBasis = `${clamp(fraction * total, MIN_PANE_PX, Math.max(MIN_PANE_PX, total - MIN_PANE_PX))}px`
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true
    dividerEl?.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return
    const container = props.container()
    const pane = props.pane()
    if (!container || !pane) return
    const rect = container.getBoundingClientRect()
    const total = horizontal() ? rect.width : rect.height
    const from = horizontal() ? rect.right - e.clientX : rect.bottom - e.clientY
    pane.style.flexBasis = `${clamp(from, MIN_PANE_PX, Math.max(MIN_PANE_PX, total - MIN_PANE_PX))}px`
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return
    dragging = false
    dividerEl?.releasePointerCapture(e.pointerId)
    const container = props.container()
    const pane = props.pane()
    if (!container || !pane) return
    const total = extent(container)
    if (total > 0) props.set(clamp(extent(pane) / total, 0.1, 0.9))
  }

  onMount(() => {
    applyFraction(props.get())
    const container = props.container()
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (!dragging) applyFraction(props.get())
    })
    ro.observe(container)
    onCleanup(() => {
      ro.disconnect()
      // The other axis's layout must not inherit this one's inline size (the
      // canvas split only exists on desktop — see ui/app.tsx).
      const pane = props.pane()
      if (pane) pane.style.flexBasis = ''
    })
  })

  return (
    <div
      class="pane-divider"
      role="separator"
      aria-orientation={horizontal() ? 'vertical' : 'horizontal'}
      aria-label={props.label ?? 'Resize panes'}
      ref={dividerEl}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}
