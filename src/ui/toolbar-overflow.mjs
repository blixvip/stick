/**
 * Priority-plus toolbars: controls that do not fit move into a "More" menu, so
 * nothing is ever cut off or lost. computeOverflow() is pure (measured widths
 * in, the split out); installToolbarOverflow() measures with observers and
 * moves controls into the menu and back. Nothing here decides which controls
 * exist or are shown: the toolbar's markup, its owners and its
 * data-overflow-* attributes do.
 *
 *   data-overflow-priority="n"  higher stays visible longer (default 0)
 *   data-overflow-pinned        never moves into the menu
 */

/**
 * items      [{width, priority = 0, pinned = false}] in visual order
 * available  the toolbar's inner width
 * gap        space between neighbouring items
 * moreWidth  the More button's width (it takes one more gap)
 *
 * Returns {visible, overflow, width, fits}: item indices in visual order, the
 * width the visible row takes, and whether it fits. The lowest priority goes
 * first; among equals, the last item in the row. Pinned items always stay.
 */
export function computeOverflow({items, available, gap = 0, moreWidth = 0}) {
  const count = items.length;
  const hidden = new Set();
  const used = () => {
    let width = 0, shown = 0;
    for (let index = 0; index < count; index++) if (!hidden.has(index)) { width += items[index].width; shown++; }
    width += Math.max(0, shown - 1) * gap;
    if (hidden.size) width += (shown ? gap : 0) + moreWidth;
    return width;
  };
  const order = items.map((item, index) => index).filter(index => !items[index].pinned)
    .sort((a, b) => (items[a].priority ?? 0) - (items[b].priority ?? 0) || b - a);
  for (const index of order) {
    if (used() <= available) break;
    hidden.add(index);
  }
  const all = items.map((item, index) => index);
  return {visible: all.filter(index => !hidden.has(index)), overflow: all.filter(index => hidden.has(index)), width: used(), fits: used() <= available};
}

/** Menu items for overflowed controls: each runs by clicking the original control, so its data-action path stays the one path. */
export function overflowMenuItems(elements) {
  return elements.map(element => {
    const pressed = element.getAttribute('aria-pressed');
    return {
      label: element.getAttribute('aria-label') || element.dataset.tooltip || element.textContent.trim(),
      disabled: element.disabled || element.getAttribute('aria-disabled') === 'true',
      ...(pressed === 'true' || pressed === 'false' ? {checked: pressed === 'true'} : {}),
      run: event => element.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, shiftKey: event?.shiftKey,
        ctrlKey: event?.ctrlKey, metaKey: event?.metaKey, altKey: event?.altKey})),
    };
  });
}


/** Set on a control while it waits in the More menu (with an inline display: none !important). */
export const OVERFLOW_ATTRIBUTE = 'data-overflowed';

/**
 * Keeps `toolbar` (sized by its container, never by its content) inside its
 * width. `items()` returns the controls in visual order; `more` is the More
 * button, shown only while something overflows. onChange(overflowed) runs
 * after every change, for example to rebuild the More menu.
 *
 * Visibility stays with the controls' owners: an overflowed control gets
 * data-overflowed and an inline `display: none !important` (restored after),
 * never the `hidden` attribute. A control its owner hides (`hidden`) is left
 * out; one the owner shows or adds is measured and placed. The toolbar, each
 * control and the toolbar's children are observed, so this happens even when
 * the toolbar's width stays the same; call update() after changes nothing
 * observes (a control hidden by a class).
 */
export function installToolbarOverflow(toolbar, {items, more, gap = null, signal, onChange = null,
  priority = element => Number(element.dataset.overflowPriority) || 0,
  pinned = element => element.hasAttribute('data-overflow-pinned'),
  Observer = globalThis.ResizeObserver, Mutations = globalThis.MutationObserver,
  requestFrame = callback => globalThis.requestAnimationFrame(callback), cancelFrame = id => globalThis.cancelAnimationFrame(id)} = {}) {
  const ours = new Map(), widths = new WeakMap(), observed = new WeakSet();
  let overflowed = [], frame = 0;
  const conceal = element => {
    if (ours.has(element)) return;
    const {style} = element;
    ours.set(element, {value: style.getPropertyValue('display'), priority: style.getPropertyPriority('display')});
    style.setProperty('display', 'none', 'important');
    element.setAttribute(OVERFLOW_ATTRIBUTE, '');
  };
  const reveal = element => {
    const saved = ours.get(element);
    if (!saved) return;
    ours.delete(element);
    element.removeAttribute(OVERFLOW_ATTRIBUTE);
    const {style} = element;
    // Put back what the owner had, unless it has written its own display since.
    if (style.getPropertyValue('display') !== 'none' || style.getPropertyPriority('display') !== 'important') return;
    if (saved.value) style.setProperty('display', saved.value, saved.priority); else style.removeProperty('display');
  };
  const measure = element => {
    if (!ours.has(element)) widths.set(element, element.getBoundingClientRect().width);
    return widths.get(element) ?? 0;
  };
  const update = () => {
    if (frame) { cancelFrame(frame); frame = 0; }
    if (!toolbar.getClientRects().length) return;   // not rendered: nothing to measure
    const list = [...items()];
    for (const element of list) if (!observed.has(element)) { observed.add(element); resize?.observe(element); }
    // A control its owner hid, or that left the toolbar, is released as the owner left it.
    for (const element of [...ours.keys()]) if (element.hidden || !list.includes(element)) reveal(element);
    const all = list.filter(element => !element.hidden);
    // Overflowed controls whose width is unknown (after invalidate()) are measured once, shown.
    for (const element of all) if (ours.has(element) && !widths.has(element)) reveal(element);
    for (const element of all) measure(element);
    const style = toolbar.ownerDocument?.defaultView?.getComputedStyle?.(toolbar);
    const spacing = gap ?? (Number.parseFloat(style?.columnGap) || 0);
    const padding = (Number.parseFloat(style?.paddingLeft) || 0) + (Number.parseFloat(style?.paddingRight) || 0);
    const available = toolbar.clientWidth - padding;
    const moreWidth = more ? (more.hidden ? widths.get(more) ?? 32 : measure(more)) : 0;
    const {overflow} = computeOverflow({items: all.map(element => ({width: widths.get(element) ?? 0, priority: priority(element), pinned: pinned(element)})),
      available, gap: spacing, moreWidth});
    const next = overflow.map(index => all[index]);
    for (const element of all) if (next.includes(element)) conceal(element); else reveal(element);
    const moreHidden = next.length === 0;
    if (more && more.hidden !== moreHidden) more.hidden = moreHidden;
    if (next.length !== overflowed.length || next.some((element, index) => element !== overflowed[index])) {
      overflowed = next;
      onChange?.(overflowed);
    }
  };
  const schedule = () => { frame ||= requestFrame(update); };
  const resize = Observer ? new Observer(schedule) : null;
  resize?.observe(toolbar);
  // A control shown, hidden or added while the width stays the same. Only the owners' changes count:
  // the engine writes data-overflowed and inline styles on controls, and `hidden` only on More.
  const mutations = Mutations ? new Mutations(records => {
    if (records.some(record => record.type === 'childList' || (record.attributeName === 'hidden' && record.target !== more))) schedule();
  }) : null;
  mutations?.observe(toolbar, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});
  signal?.addEventListener('abort', () => {
    resize?.disconnect();
    mutations?.disconnect();
    if (frame) cancelFrame(frame);
    frame = 0;
    for (const element of [...ours.keys()]) reveal(element);
    if (more) more.hidden = true;
  }, {once: true});
  schedule();
  return {
    update,
    /** Forget measured widths, for example after the language changed the labels. */
    invalidate() { for (const element of items()) widths.delete(element); schedule(); },
    get overflowed() { return [...overflowed]; },
  };
}
