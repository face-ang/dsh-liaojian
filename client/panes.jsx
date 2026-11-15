import React, { useLayoutEffect, useRef, useState } from 'react'

const storageKey = 'liaojian.pane-widths'
const minSidebar = 128
const minList = 250
const minReader = 300
const maxSidebar = 320
const maxList = 620
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function savedWidths() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey))
    if (Number.isFinite(value?.sidebar) && Number.isFinite(value?.list)) return value
  } catch { /* Storage can be unavailable in an embedded window. */ }
  return null
}

export function usePaneWidths() {
  const frame = useRef(null)
  const [total, setTotal] = useState(0)
  const [widths, setWidths] = useState(savedWidths)
  useLayoutEffect(() => {
    const element = frame.current
    const measure = () => setTotal(element.clientWidth)
    const observer = new ResizeObserver(measure)
    measure()
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  if (total <= 755) return { frame }

  const usable = total - minReader
  const sidebar = clamp(widths?.sidebar ?? (total <= 960 ? 140 : Math.round(clamp(total * 0.18, 162, 224))),
    minSidebar, Math.min(maxSidebar, usable - minList))
  const list = clamp(widths?.list ?? Math.round(total <= 960 ? Math.max(255, total * 0.31) : clamp(total * 0.284, 284, 360)),
    minList, Math.min(maxList, usable - sidebar))

  function resize(side, value, persist) {
    const next = side === 'sidebar' ? { sidebar: value, list: sidebar + list - value } : { sidebar, list: value }
    setWidths(next)
    if (persist) {
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* Keep widths for the current view. */ }
    }
  }

  return {
    frame, style: { '--lj-sidebar-width': `${sidebar}px`, '--lj-list-width': `${list}px` },
    sidebar: { value: sidebar, min: Math.max(minSidebar, sidebar + list - maxList), max: Math.min(maxSidebar, sidebar + list - minList) },
    list: { value: list, min: minList, max: Math.min(maxList, usable - sidebar) }, resize,
  }
}

export function PaneDivider({ side, panes, label, controls }) {
  const drag = useRef(null)
  const [dragging, setDragging] = useState(false)
  if (!panes[side]) return null
  const { value, min, max } = panes[side]
  const move = (next, persist) => panes.resize(side, clamp(next, min, max), persist)

  return <div className="lj-pane-divider" data-side={side} data-dragging={dragging} role="separator" tabIndex={0}
    aria-orientation="vertical" aria-label={label} aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} 像素`}
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.focus({ preventScroll: true })
      event.preventDefault()
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: value }
      setDragging(true)
    }}
    onPointerMove={event => {
      const start = drag.current
      if (start?.pointerId === event.pointerId) move(start.width + event.clientX - start.x, false)
    }}
    onPointerUp={event => {
      const start = drag.current
      if (start?.pointerId !== event.pointerId) return
      move(start.width + event.clientX - start.x, true)
      drag.current = null
      setDragging(false)
    }}
    onLostPointerCapture={() => {
      if (!drag.current) return
      move(drag.current.width, false)
      drag.current = null
      setDragging(false)
    }}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 10
      const next = { ArrowLeft: value - step, ArrowRight: value + step, Home: min, End: max }[event.key]
      if (typeof next !== 'number') return
      event.preventDefault()
      move(next, true)
    }} />
}
