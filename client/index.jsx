import React from 'react'
import { Workbench } from './workbench.jsx'
import { Mark } from './icons.jsx'
import css from './workbench.css'

const PANEL = 'liaojian'
export const name = 'liaojian-client'
export const inject = ['slots', 'layout']

function Page() {
  return <div className="lj-root" lang="zh-CN"><style>{css}</style><Workbench /></div>
}

export function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: PANEL,
  }, Page)), 'liaojian: main panel')
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL, order: 5, label: '聊笺',
  }, ({ size }) => <Mark size={size} />)), 'liaojian: navigation')
}
