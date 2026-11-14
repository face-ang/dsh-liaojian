import React from 'react'

const shapes = {
  grid: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
  list: 'M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01',
  message: 'M21 11.2a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.3-.6L4 21l1.4-4.3A8 8 0 0 1 4 11.2a8.5 8.5 0 1 1 17 0ZM9 9.5h7M9 13h5',
  book: 'M12 6v15M12 6c-2.8-2-6-2.5-9-1.5v14c3-1 6.2-.5 9 1.5 2.8-2 6-2.5 9-1.5v-14C18 3.5 14.8 4 12 6Z',
  pen: 'm4 16-1 5 5-1L21 7l-4-4L4 16Zm10-10 4 4',
  bulb: 'M8.5 16c0-1.6-2.5-3.1-2.5-6a6 6 0 1 1 12 0c0 2.9-2.5 4.4-2.5 6m-7 3h7m-6 3h5M12 1v1M2 6l1 1m19-1-1 1M2 14h1m18 0h1',
  person: 'M5 21v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  people: 'M2 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2m4-6a5 5 0 0 1 4 5v1M12 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-4a4 4 0 0 1 0 8',
  chat: 'M3 4h18v13H8l-5 4zm4 4h10m-10 4h7',
  star: 'm12 2 3 6.4 7 .9-5.1 4.9 1.3 6.9-6.2-3.3-6.2 3.3 1.3-6.9L2 9.3l7-.9L12 2Z',
  file: 'M5 3h10l4 4v14H5zM15 3v5h4M8 11h8m-8 3h8m-8 3h5',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-2 5 5 5',
  left: 'm14 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
  down: 'm6 9 6 6 6-6',
  up: 'm6 15 6-6 6 6',
  spark: 'M12 2c.7 6.2 3.8 9.3 10 10-6.2.7-9.3 3.8-10 10C11.3 15.8 8.2 12.7 2 12c6.2-.7 9.3-3.8 10-10Z',
  upload: 'M12 15V3m-4 4 4-4 4 4M4 14v6h16v-6',
  download: 'M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5',
  plus: 'M12 5v14M5 12h14',
  inbox: 'M3 14l3-9h12l3 9v6H3zm0 0h5l1 2h6l1-2h5',
  settings: 'M10 2h4l.7 3 2 .9 2.9-1.2 2 3.4-2.2 2.2v2.4l2.2 2.2-2 3.4-2.9-1.2-2 .9-.7 3h-4l-.7-3-2-.9-2.9 1.2-2-3.4 2.2-2.2v-2.4L2.4 8.1l2-3.4 2.9 1.2 2-.9zm5 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  calendar: 'M4 5h16v16H4zm0 5h16M8 3v4m8-4v4',
  filter: 'M4 6h16m-13 6h10m-7 6h4',
  more: 'M5 12h.01m7 0h.01m7 0h.01',
  close: 'M6 6l12 12M18 6 6 18',
  alert: 'm12 3 10 17H2zm0 6v4m0 3h.01',
  copy: 'M8 8h12v12H8zM16 4H4v12',
  refresh: 'M20 7a9 9 0 1 0 .6 9M20 3v5h-5',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  link: 'M13.5 4.5a4 4 0 0 1 5.7 5.7l-3 3m-5.7 6.3a4 4 0 0 1-5.7-5.7l3-3m1 4.2 6.2-6.2',
}

export function Icon({ name, size = 16, ...props }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d={shapes[name] ?? shapes.file} />
  </svg>
}

export function Mark({ size = 34, color = false }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 32 32" fill="none">
    <path d="M6.4 9.4c0-2 1.6-3.6 3.6-3.6h13a3.6 3.6 0 0 1 3.6 3.6v10.1a3.6 3.6 0 0 1-3.6 3.6H14l-5.7 3v-3.6a3.6 3.6 0 0 1-1.9-3.2Z"
      fill={color ? '#e5ece0' : 'none'} stroke={color ? '#243c32' : 'currentColor'} strokeWidth="1.65" strokeLinejoin="round" />
    <path d="M11.4 11.4h10.2m-10.2 4h10.2m-10.2 4h5.9" stroke={color ? '#243c32' : 'currentColor'} strokeWidth="1.65" strokeLinecap="round" />
    {color && <circle cx="25.2" cy="6.6" r="3.3" fill="#e4b55e" stroke="#f4f4f5" strokeWidth="1.2" />}
  </svg>
}
