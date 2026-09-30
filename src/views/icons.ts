import { raw, Safe } from "./html.js";

// Simple line icons (24px grid, drawn for this app), used inside iOS-style colored tiles.
const paths: Record<string, string> = {
  business: '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  claude: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h2M14 14h2M8 17h2"/>',
  test: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h8M8 13h5"/>',
  widget: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6" fill="currentColor"/><circle cx="9" cy="6.5" r=".6" fill="currentColor"/><path d="M13 13h5v4h-5z"/>',
  whatsapp: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1.2-1.4-2-1-1 .8a4 4 0 0 1-2.1-2.1l.8-1-1-2z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
};

// iOS system colors per icon.
export const tileColor: Record<string, string> = {
  business: "#007aff", claude: "#d97757", calendar: "#ff3b30", test: "#5856d6",
  widget: "#32ade6", whatsapp: "#34c759", users: "#ff9500", check: "#34c759", clock: "#ff9500", bolt: "#af52de",
  lock: "#8e8e93", inbox: "#8e8e93",
};

export function icon(name: string, size = 18): Safe {
  return raw(
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`
  );
}

/** Colored rounded-square tile with a white icon, like iOS Settings. */
export function tile(name: string, size: "sm" | "lg" = "sm"): Safe {
  return raw(
    `<span class="tile ${size}" style="--tile:${tileColor[name] ?? "#8e8e93"}">${icon(name, size === "lg" ? 26 : 17).value}</span>`
  );
}
