/** Small, local SVG vocabulary for effect and target controls. */
const shapes={
 tint:'<path d="M12 3C9 7 5 10 5 14a7 7 0 0 0 14 0c0-4-4-7-7-11Z"/><path d="M8 15a4 4 0 0 0 4 4"/>',
 glow:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
 outline:'<rect x="3" y="3" width="18" height="18" rx="5"/><rect x="7" y="7" width="10" height="10" rx="2"/>',
 shadow:'<path d="M9 18h8a4 4 0 0 0 4-4V9"/><rect x="3" y="3" width="14" height="14" rx="3"/>',
 blur:'<path d="M3 6h10M3 10h15M6 14h15M11 18h10"/>',
 grade:'<path d="M4 4v16M12 4v16M20 4v16"/><path d="M1 9h6m2 6h6m2-8h6"/>',
 pixelate:'<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
 noise:'<path d="M4 4h.1M12 3h.1M20 6h.1M7 10h.1M15 11h.1M3 17h.1M12 19h.1M20 17h.1" stroke-width="3.5"/>',
 vignette:'<rect x="2" y="4" width="20" height="16" rx="5"/><ellipse cx="12" cy="12" rx="5" ry="4"/>',
 dissolve:'<path d="M3 4h10v16H3zM17 4h.1M20 9h.1M16 14h.1M20 20h.1"/>',
 rgbSplit:'<circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5"/><path d="M12 5v14"/>',
 wave:'<path d="M2 8c5-10 5 10 10 0s5 10 10 0M2 16c5-10 5 10 10 0s5 10 10 0"/>',
 shockwave:'<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M1 12h2m18 0h2M12 1v2m0 18v2"/>',
 bloom:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
 lightSweep:'<path d="m4 21 9-18h7l-9 18ZM3 8h4M17 16h4"/>',
 crt:'<rect x="2" y="5" width="20" height="15" rx="3"/><path d="m8 2 4 3 4-3M6 9h12M6 13h12M6 17h12"/>',
 turbulence:'<path d="M2 7c6-9 10 9 20 0M2 12c8-9 9 9 20 0M2 17c5-9 13 9 20 0"/>',
 effects:'<path d="m12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2ZM20 2v4m-2-2h4"/>',
 particles:'<circle cx="7" cy="16" r="2"/><circle cx="14" cy="9" r="1.5"/><circle cx="18" cy="16" r="1"/><circle cx="10" cy="6" r="1"/><path d="M4 21c3-4 6-5 9-5"/>',
 aura:'<circle cx="12" cy="7" r="2.5"/><path d="M12 10v6m-3 4 3-4 3 4M8 12h8"/><path d="M5 20C3 14 5 7 8 4m11 16c2-6 0-13-3-16"/>',
 beam:'<circle cx="5" cy="12" r="2.5"/><path d="M8 10.5h13M8 13.5h13"/><path d="m15 7-2 3m5 4-2 3"/>',
 explosion:'<path d="m12 2 2 5 5-3-2 5 5 1-5 3 3 4-5-1-1 6-2-5-4 3 1-5-6-1 5-3-3-4 5 1Z"/>',
 sparks:'<path d="M12 12 5 5m7 7 7-7m-7 7v9m0-9-8 3m8-3 8 3"/>',
 smoke:'<path d="M7 18a4 4 0 1 1 1-7.9A5 5 0 0 1 17.6 9 3.5 3.5 0 1 1 18 16H7Z"/>',
 fire:'<path d="M12 21c-4 0-6-3-6-6 0-4 3-6 4-10 2 2 3 4 3 6 1-1 2-2 2-4 2 2 3 5 3 8 0 3-2 6-6 6Z"/>',
 rain:'<path d="M8 3 6 9m6-4-2 6m6-8-2 6m-6 4-2 6m6-4-2 6m6-8-2 6"/>',
 snow:'<path d="M12 3v18M4 7.5l16 9m0-9-16 9"/><path d="m9 4 3 2 3-2m-6 16 3-2 3 2"/>',
 sparkle:'<path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8Z"/>',
 confetti:'<path d="m4 20 6-14 8 8-14 6Z"/><path d="M14 4h.1M19 6h.1M20 11h.1M17 2l1 2" stroke-width="2.2"/>',
 speed:'<path d="M3 7h12M7 12h14M3 17h10"/>',
 lightning:'<path d="M13 2 5 13h6l-1 9 8-11h-6Z"/>',
 dice:'<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8.6 8.6h.1M15.4 8.6h.1M12 12h.1M8.6 15.4h.1M15.4 15.4h.1" stroke-width="2.6"/>',
 grip:'<path d="M9 5h.1m5 0h.1M9 12h.1m5 0h.1M9 19h.1m5 0h.1" stroke-width="3"/>',
 camera:'<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="12" cy="12" r="4"/>',
 movieclip:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4m-10-8 5 4-5 4Z"/>',
};
export const vfxIcon=name=>`<svg class="icon vfx-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]??shapes.effects}</svg>`;
/** Each catalogue category's tint (the design system's concept hues), so an effect's tile says what kind it is. */
const TINTS={Generate:'fx',Looks:'fx',Light:'camera',Color:'draw',Distort:'time',Blur:'select',Texture:'library'};
/** An effect's glyph on a small tile in its category's tint. */
export const vfxTile=(name,category,cls='')=>`<span class="vfx-tile${cls?` ${cls}`:''}" data-tint="${TINTS[category]??'fx'}" aria-hidden="true">${vfxIcon(name)}</span>`;
