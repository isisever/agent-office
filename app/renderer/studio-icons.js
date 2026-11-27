// Studio's icons (contract v3.120): simple 1.6px strokes on a 20×20 grid, drawn for Agent Office. Built with
// createElementNS from fixed path data (no markup strings), coloured by currentColor.

const NS = 'http://www.w3.org/2000/svg';
/** @type {Record<string, string[]>} each icon: its path data (several paths per icon) */
const PATHS = {
  back: ['M8.5 4.5 3 10l5.5 5.5', 'M3.5 10H17'],
  info: ['M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M10 9v4.5', 'M10 6.5h.01'],
  team: ['M7.5 9.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z', 'M2.5 16c.5-2.75 2.5-4.25 5-4.25s4.5 1.5 5 4.25', 'M13 4.25a2.5 2.5 0 0 1 0 5', 'M14.5 11.9c1.6.45 2.7 1.8 3 4.1'],
  plug: ['M7 2.75v3.5', 'M13 2.75v3.5', 'M5 6.25h10v3a5 5 0 0 1-10 0Z', 'M10 14.25v3'],
  leaf: ['M3.5 14.5c0-6.5 4.25-11 11-11 0 6.75-4.5 11-11 11Z', 'M3.5 14.5 10 8'],   // v3.133 economy mode
  coffee: ['M3.75 7.5h10v4.25a4 4 0 0 1-4 4h-2a4 4 0 0 1-4-4Z', 'M13.75 9h1.25a2 2 0 0 1 0 4h-1.25', 'M7 2.75v2.5', 'M10.5 2.75v2.5'],
  plus: ['M10 4.5v11', 'M4.5 10h11'],
  folder: ['M2.75 5.25h5l1.5 1.75h8v8.75H2.75Z'],
  branch: ['M6 3.5v13', 'M6 16.5a1.75 1.75 0 1 0 0-.01', 'M14 7.25a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z', 'M14 7.25c0 4-8 3-8 7.25'],
  user: ['M10 10a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z', 'M3.75 16.75a6.25 6.25 0 0 1 12.5 0'],
  monitor: ['M2.75 4h14.5v9.5H2.75Z', 'M7 16.5h6', 'M10 13.5v3'],
  sun: ['M10 13.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z', 'M10 2v1.75M10 16.25V18M2 10h1.75M16.25 10H18M4.34 4.34l1.24 1.24M14.42 14.42l1.24 1.24M4.34 15.66l1.24-1.24M14.42 5.58l1.24-1.24'],
  moon: ['M16.25 11.75A6.5 6.5 0 0 1 8.25 3.75a6.5 6.5 0 1 0 8 8Z'],
  copy: ['M7.25 7.25h9v9.5h-9Z', 'M12.75 7.25V3.25h-9.5v9.5h4'],
  down: ['M10 4v12', 'M5 11l5 5 5-5'],
  send: ['M10 16V4', 'M5 9l5-5 5 5'],
  search: ['M8.75 14.5a5.75 5.75 0 1 0 0-11.5 5.75 5.75 0 0 0 0 11.5Z', 'M13 13l3.5 3.5'],
  home: ['M3.5 9 10 3.75 16.5 9', 'M5.25 7.75v8.5h9.5v-8.5'],
  board: ['M3 3.5h14v13H3Z', 'M7.67 3.5v13', 'M12.33 3.5v13'],
  report: ['M5.5 2.75h6l3 3v11.5h-9Z', 'M11.5 2.75v3h3', 'M7.75 10.25h4.5', 'M7.75 13.25h4.5'],
  clock: ['M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'M10 6.25V10l2.5 1.75'],
  command: ['M7 7h6v6H7Z', 'M7 7V5.25A1.75 1.75 0 1 0 5.25 7H7', 'M13 7V5.25A1.75 1.75 0 1 1 14.75 7H13', 'M7 13v1.75A1.75 1.75 0 1 1 5.25 13H7', 'M13 13v1.75A1.75 1.75 0 1 0 14.75 13H13'],
  chevron: ['M7.5 5.5 12 10l-4.5 4.5'],
  chevronDown: ['M5.5 8 10 12.5 14.5 8'],
  // A cog with eight teeth (not rays, which read as a sun next to the theme control).
  gear: ['M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', 'M16.20 8.43 L18.11 8.76 L18.11 11.24 L16.20 11.57 L15.50 13.27 L16.61 14.86 L14.86 16.61 L13.27 15.50 L11.57 16.20 L11.24 18.11 L8.76 18.11 L8.43 16.20 L6.73 15.50 L5.14 16.61 L3.39 14.86 L4.50 13.27 L3.80 11.57 L1.89 11.24 L1.89 8.76 L3.80 8.43 L4.50 6.73 L3.39 5.14 L5.14 3.39 L6.73 4.50 L8.43 3.80 L8.76 1.89 L11.24 1.89 L11.57 3.80 L13.27 4.50 L14.86 3.39 L16.61 5.14 L15.50 6.73 Z'],
  office: ['M3.5 3.5h5.25v5.25H3.5ZM11.25 3.5h5.25v5.25h-5.25ZM3.5 11.25h5.25v5.25H3.5ZM11.25 11.25h5.25v5.25h-5.25Z'],
  device: ['M3 4.5h14v9H3Z', 'M7.5 16.5h5', 'M10 13.5v3'],
  paperclip: ['M15.5 9.25 9.9 14.85a3.5 3.5 0 0 1-4.95-4.95l6.01-6.01a2.33 2.33 0 0 1 3.3 3.3L8.2 13.25a1.17 1.17 0 0 1-1.65-1.65l5.3-5.3'],
  mic: ['M10 12.75a2.75 2.75 0 0 0 2.75-2.75V5.5a2.75 2.75 0 0 0-5.5 0V10A2.75 2.75 0 0 0 10 12.75Z', 'M5 9.75a5 5 0 0 0 10 0', 'M10 14.75v2.5'],
  arrowUp: ['M10 15.5v-11', 'M5.5 9 10 4.5 14.5 9'],
  stop: ['M6.5 6.5h7v7h-7Z'],
  more: ['M5 10h.01M10 10h.01M15 10h.01'],
  file: ['M5.5 2.75h6l3 3v11.5h-9Z', 'M11.5 2.75v3h3'],
  close: ['M5.5 5.5l9 9', 'M14.5 5.5l-9 9'],
  terminal: ['M3 4.5h14v11H3Z', 'M6 8l2.5 2L6 12', 'M10.5 12.5h3.5'],
  chat: ['M4 4.5h12v8.5H9l-3.5 3v-3H4Z'],
  reply: ['M8 5 3.5 9.5 8 14', 'M3.5 9.5h7.75a5 5 0 0 1 5 5V16'],
  edit: ['M12.75 3.75l3.5 3.5-8.75 8.75H4v-3.5Z', 'M10.75 5.75l3.5 3.5'],
};

/** An icon element (aria-hidden; the button around it carries the label). */
export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '2.6' : '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `st-icon st-icon-${name}`);
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
