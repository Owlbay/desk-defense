/** 界面小图标（内联 SVG，调色板与文档 06 一致） */
const O = '#3B2F2A';
const wrap = (body: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${O}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;

export const G = {
  heart: wrap(`<path d="M12 20.5 4.2 12.9a4.7 4.7 0 0 1 6.6-6.7L12 7.4l1.2-1.2a4.7 4.7 0 0 1 6.6 6.7Z" fill="#E63946"/><path d="M7.5 9.2a2 2 0 0 1 1.8-1.4" stroke="#fff" stroke-opacity=".7"/>`),
  coin: wrap(`<circle cx="12" cy="12" r="8.5" fill="#F5D76E"/><circle cx="12" cy="12" r="5.2" fill="#D4A82C" stroke-width="1.6"/><path d="M12 9.3v5.4" stroke-width="1.8"/>`),
  wave: wrap(`<path d="M2.5 10.5c2.4-3 4.8-3 7.2 0s4.8 3 7.2 0 3.6-2.2 4.6-1.4" stroke="#2A9D8F" stroke-width="2.6"/><path d="M2.5 16c2.4-3 4.8-3 7.2 0s4.8 3 7.2 0 3.6-2.2 4.6-1.4" stroke="#4FA3E0" stroke-width="2.6"/>`),
  star: wrap(`<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8Z" fill="#F5D76E"/>`),
  starEmpty: wrap(`<path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8Z" fill="#D4BC94" stroke-opacity=".55"/>`),
  ink: wrap(`<path d="M12 3.2c3.6 4.4 6 7.7 6 10.6a6 6 0 0 1-12 0c0-2.9 2.4-6.2 6-10.6Z" fill="#2E4A7D"/><path d="M9.2 14.4a3 3 0 0 0 2 2.6" stroke="#fff" stroke-opacity=".7"/>`),
  score: wrap(`<circle cx="12" cy="14" r="6.5" fill="#F5D76E"/><path d="m8.5 3 3.5 4.5L15.5 3" fill="none"/><path d="m12 10.6 1 2.1 2.3.3-1.7 1.6.4 2.2-2-1.1-2 1.1.4-2.2-1.7-1.6 2.3-.3Z" fill="#D4A82C" stroke-width="1.2"/>`),
  pause: wrap(`<rect x="6" y="5" width="4" height="14" rx="1.2" fill="${O}"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="${O}"/>`),
  play: wrap(`<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z" fill="currentColor"/>`),
  fast: wrap(`<path d="M3.5 6v12l8-6Z M12.5 6v12l8-6Z" fill="currentColor"/>`),
  lock: wrap(`<rect x="5" y="10.5" width="14" height="10" rx="2.4" fill="#D4BC94"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.3" r="1.3" fill="${O}"/>`),
  check: wrap(`<path d="m5 12.5 4.5 4.5L19 7.5" stroke-width="3"/>`),
  back: wrap(`<path d="M15 5 8 12l7 7" stroke-width="2.8"/>`),
  gear: wrap(`<path d="M12 2.8 14 5l3-.4.6 2.9 2.7 1.4-1.1 2.8 1.1 2.8-2.7 1.4-.6 2.9-3-.4-2 2.2-2-2.2-3 .4-.6-2.9-2.7-1.4 1.1-2.8-1.1-2.8 2.7-1.4L7 4.6l3 .4Z" fill="#A0AEC0"/><circle cx="12" cy="12" r="3.2" fill="#FBF8F1"/>`),
  trophy: wrap(`<path d="M7 4h10v5a5 5 0 0 1-10 0Z" fill="#F5D76E"/><path d="M7 6H4.5a2.5 2.5 0 0 0 3 4M17 6h2.5a2.5 2.5 0 0 1-3 4M12 14v3.5M8 20.5h8l-1-3H9Z"/>`),
  bag: wrap(`<rect x="4" y="7" width="16" height="13.5" rx="3" fill="#B23A48"/><path d="M8.5 7V5.5a3.5 3.5 0 0 1 7 0V7"/><rect x="8" y="12" width="8" height="4.5" rx="1.2" fill="#F2E3C6"/>`),
  book: wrap(`<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z" fill="#2A9D8F"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z" fill="#FBF8F1"/><path d="M8 7.5h8"/>`),
  infinity: wrap(`<path d="M12 12c-2-2.8-3.6-4.2-5.5-4.2a4.2 4.2 0 0 0 0 8.4c1.9 0 3.5-1.4 5.5-4.2s3.6-4.2 5.5-4.2a4.2 4.2 0 0 1 0 8.4c-1.9 0-3.5-1.4-5.5-4.2Z" stroke="#6C5B7B" stroke-width="2.6"/>`),
  sliders: wrap(`<path d="M5 4v16M12 4v16M19 4v16"/><rect x="2.5" y="12" width="5" height="4" rx="1.5" fill="#F2C14E"/><rect x="9.5" y="6" width="5" height="4" rx="1.5" fill="#F28AA0"/><rect x="16.5" y="14" width="5" height="4" rx="1.5" fill="#9BD1E5"/>`),
  bolt: wrap(`<path d="M13.5 2.5 5 13.5h6l-1.5 8 8.5-11h-6Z" fill="#F5D76E"/>`),
  copy: wrap(`<rect x="8" y="8" width="12" height="12" rx="2.5" fill="#FBF8F1"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>`),
  close: wrap(`<path d="M6 6l12 12M18 6 6 18" stroke-width="2.8"/>`),
  skull: wrap(`<path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.2 4.4 3 5.5V20h10v-3.5c1.8-1.1 3-2.9 3-5.5a8 8 0 0 0-8-8Z" fill="#FBF8F1"/><circle cx="9" cy="11.5" r="1.8" fill="${O}"/><circle cx="15" cy="11.5" r="1.8" fill="${O}"/><path d="M10 20v-2.5M14 20v-2.5"/>`),
  sword: wrap(`<path d="M14.5 3.5H20v5.5L9.5 19.5l-5-5Z" fill="#A0AEC0"/><path d="m4 20 3-3M6.5 13.5l4 4"/>`),
  plane: wrap(`<path d="M2.5 11.5 21 4l-5.5 16-4-6.5Z" fill="#FBF8F1"/><path d="m11.5 13.5 9.5-9.5"/>`),
  rush: wrap(`<path d="M3 8h7M2 12h6M3 16h7" stroke="#E8833A"/><path d="M12 5.5 20.5 12 12 18.5Z" fill="#E8833A"/>`),
  crown: wrap(`<path d="M3.5 8.5 8 12l4-6.5 4 6.5 4.5-3.5L19 18H5Z" fill="#F5D76E"/><path d="M5 20.5h14"/>`),
  refresh: wrap(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4.5H15" stroke-width="2.4"/>`),
  undo: wrap(`<path d="M9 14 4 9l5-5" stroke-width="2.4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3" stroke-width="2.4"/>`),
  up: wrap(`<path d="M12 19V5M6 11l6-6 6 6" stroke-width="2.8"/>`),
  sell: wrap(`<circle cx="12" cy="12" r="8.5" fill="#F5D76E"/><path d="M12 7v10M9 14l3 3 3-3" stroke-width="2.2"/>`),
  target: wrap(`<circle cx="12" cy="12" r="8" fill="#FBF8F1"/><circle cx="12" cy="12" r="4" fill="#F28AA0"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>`),
  music: wrap(`<path d="M9 18V5.5l11-2V16" /><circle cx="6.5" cy="18" r="2.6" fill="#F2C14E"/><circle cx="17.5" cy="16" r="2.6" fill="#F2C14E"/>`),
  sound: wrap(`<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4Z" fill="#9BD1E5"/><path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>`),
  eye: wrap(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="#FBF8F1"/><circle cx="12" cy="12" r="3.2" fill="#2E4A7D"/>`),
  axisRow: wrap(`<rect x="3" y="9" width="18" height="6" rx="1.5" fill="#9BD1E5"/><path d="M6 9v2.5M9 9v2M12 9v2.5M15 9v2M18 9v2.5" stroke-width="1.4"/>`),
  axisCol: wrap(`<rect x="9" y="3" width="6" height="18" rx="1.5" fill="#9BD1E5"/><path d="M9 6h2.5M9 9h2M9 12h2.5M9 15h2M9 18h2.5" stroke-width="1.4"/>`),
};

export type GlyphName = keyof typeof G;
