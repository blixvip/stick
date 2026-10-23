import {localizedText, localizedAttribute, appendLocalized, localizedMarkup, clearTranslation} from './localization-bindings.mjs';
import {messageError} from './localized-error.mjs';
import {t as interfaceText} from './localization.mjs';

/**
 * The inspector's header (architecture.md §3.13, experience.md §5.1): the one
 * writer of the target line ([data-slot=inspector-target]: the kind glyph, the
 * target's name, #inspector-context and #object-actions), of the scope line
 * and the quick actions row under it ([data-slot=inspector-head]) and of
 * #inspector[data-selection-kind]. It draws what inspector-view.mjs's
 * descriptor says: {target: {name, glyph, rename, label, selection}, scope,
 * quick}. No crumbs, meta, chips, badges or key state.
 *
 * - The name is the target's (Inter Tight 16/650), truncated; a double-click,
 *   or Enter or F2 while it has focus, renames it in place when the context
 *   says how (`rename`: the input's id or data hooks and its accessible name):
 *   Enter or leaving the field commits through a `change` event, as the
 *   inspector's fields do; Escape keeps the name.
 * - #inspector-context keeps the kind ("Figure", "Joint", "Scene"…) as
 *   visually hidden text, so the heading reads "Figure Bubble" to assistive
 *   technology and the kind stays where tests and the shell find it.
 * - #object-actions stays today's element (its listener opens the context's
 *   menu); the header gives it the kit's look once.
 * - The scope line and the quick actions come from inspector-kit.mjs
 *   (renderInspectorHead, syncQuickHost): one quick-actions controller per
 *   context, fed by the command registry, refreshed on every update.
 *
 * installInspectorChrome(root, ctx) wires the header and the kit's DOM half
 * (installInspectorKit: section toggles with their remembered state, step
 * buttons, slider readouts, the "more below" fade) to the Properties panel
 * once, and updates the header on every inspectorView() render.
 */
import {renderInspectorHead, syncQuickHost, installInspectorKit} from './inspector-kit.mjs';
import {updateInspectorDOM} from './inspector-dom.mjs';
import {inspectorSections, onInspectorRender} from './inspector-view.mjs';
import {setAttr, setHidden, setText} from './ui/dom-write.mjs';
import {icon as appIcon} from './icons.mjs';

const glyphMarkup = (icon, name) => (name ? icon(name, 'ui-icon') : '');

/**
 * createInspectorHeader({target, head, inspector, registry, commandContext,
 * icon, t, pins}) → {update(descriptor), rename(), destroy()}.
 *   target      [data-slot=inspector-target] (holds #inspector-context and #object-actions)
 *   head        [data-slot=inspector-head] (the scope line and the quick actions)
 *   inspector   #inspector (data-selection-kind)
 *   registry    () => the command registry, or null while the app has none yet
 *   pins        (context) => the context's pinned command ids
 */
export function createInspectorHeader({target, head, inspector, registry = () => null, commandContext = null, icon = appIcon, t = null,
  pins = () => [], document: doc = target?.ownerDocument ?? globalThis.document} = {}) {
  if (!target) throw messageError(new TypeError(''), "errors.inspectorHeader.theInspectorHeaderNeedsItsTargetSlot", {});
  const abort = new AbortController(), {signal} = abort;
  const context = doc.getElementById('inspector-context') ?? target.querySelector('#inspector-context');
  const menu = doc.getElementById('object-actions') ?? target.querySelector('#object-actions');
  // The name line: [kind] name (#inspector-context, hidden) … ⋯. index.html may carry it already; else it is
  // built once in the slot's existing markup, around today's #inspector-context and #object-actions.
  target.classList.add('ui-target');
  let name = target.querySelector('.ui-target-name'), kind = target.querySelector('.ui-target-kind'), text = name?.querySelector('.ui-target-text');
  if (!name || !kind || !text) {
    const line = context?.parentElement && context.parentElement !== target ? context.parentElement : target;
    line.classList.add('ui-target-line');
    kind = doc.createElement('span');
    kind.className = 'ui-target-kind';
    kind.setAttribute('aria-hidden', 'true');
    kind.hidden = true;
    name = doc.createElement('h2');
    name.className = 'ui-target-name';
    name.id = 'inspector-name';
    if (context) {
      context.classList.add('ui-visually-hidden');
      appendLocalized(name, context, ' ');
    }
    text = doc.createElement('span');
    text.className = 'ui-target-text';
    appendLocalized(name, text);
    line.prepend(kind, name);
  }
  if (menu && !menu.classList.contains('ui-icon-button')) {
    menu.className = 'ui-icon-button';
    menu.dataset.size = 'sm';
    if (menu.hasAttribute('title')) menu.removeAttribute('title');
    localizedMarkup(menu, glyphMarkup(icon, 'more'));
  }

  let current = null, quick = null, editing = null, glyph = null;

  function finish(commit) {
    const input = editing;
    if (!input) return;
    editing = null;
    // Leaving the field commits an edited name through its native change event, which bubbles to the
    // inspector's change handling as a field's does; Escape (or a blank name) restores the value first.
    if (!commit || !input.value.trim()) input.value = input.defaultValue;
    input.blur();
    input.remove();
    name.hidden = false;
    if (doc.activeElement === doc.body || !doc.activeElement) text.focus?.({preventScroll: true});
  }

  /** Renames the target in place, when its context says how. */
  function rename() {
    const how = current?.target?.rename;
    if (!how || editing) return false;
    const input = doc.createElement('input');
    input.type = 'text';
    input.className = 'ui-target-input';
    if (how.id) input.id = how.id;
    for (const [key, value] of Object.entries(how.data ?? {})) input.setAttribute(`data-${key}`, value === true ? '' : String(value));
    input.setAttribute('aria-label', how.description ?? interfaceText("inspectorHeader.name"));
    if (how.descriptionKey) localizedAttribute(input, 'aria-label', how.descriptionKey, how.descriptionParams);
    if (how.maxlength) input.maxLength = how.maxlength;
    input.spellcheck = false;
    input.value = input.defaultValue = current.target.name ?? '';
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    editing = input;
    name.hidden = true;
    name.after(input);
    input.focus();
    input.select();
    return true;
  }
  text.addEventListener('dblclick', () => rename(), {signal});
  text.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === 'F2') && !event.altKey && !event.ctrlKey && !event.metaKey && rename()) event.preventDefault();
  }, {signal});

  /** Draws `descriptor`'s target, scope line and quick actions; writes only what changed. */
  function update(descriptor) {
    current = descriptor;
    const info = descriptor?.target ?? {};
    const renamable = Boolean(info.rename);
    if (!editing) {
      if (info.nameKey) localizedText(text, info.nameKey, info.nameParams);
      else { clearTranslation(text); setText(text, info.name ?? ''); }
    }
    setAttr(text, 'tabindex', renamable ? '0' : null);
    setAttr(text, 'data-tooltip', renamable ? info.rename.tip ?? interfaceText("inspectorHeader.doubleClickToRename") : null);
    setAttr(name, 'data-renamable', renamable);
    if (editing && !renamable) finish(false);
    if (glyph !== (info.glyph ?? null)) {
      glyph = info.glyph ?? null;
      localizedMarkup(kind, glyphMarkup(icon, glyph));
      kind.hidden = !glyph;
    }
    if (info.labelKey) localizedText(context, info.labelKey, info.labelParams); else setText(context, info.label ?? '');
    setAttr(inspector, 'data-selection-kind', info.selection ?? descriptor?.kind ?? null);
    if (!head) return;
    const env = {icon, t};
    updateInspectorDOM(head, renderInspectorHead(descriptor, env));
    const commands = registry?.();
    const options = {registry: commands, commandContext, icon, t, pins: descriptor?.quick ? pins(descriptor.quick.context) ?? [] : []};
    if (commands) {
      const before = quick;
      quick = syncQuickHost(head, quick, options);
      if (quick && quick === before) quick.refresh();
    }
    setHidden(head, !descriptor?.scope && !(commands && descriptor?.quick));
  }

  return {
    update, rename,
    get element() { return target; },
    get quick() { return quick; },
    destroy() {
      abort.abort();
      quick?.destroy?.();
      quick = null;
    },
  };
}

/**
 * Installs the Properties panel's own behaviour once (inspector-bindings.mjs
 * calls it with its context): the header, fed by every inspectorView()
 * render, and the kit's DOM half on #inspector. `ctx.commands` and
 * `ctx.commandContext` name the registry (else the app's, once it has one),
 * `ctx.onScrubHint(text)` shows the one-time scrub hint, `ctx.pins(context)`
 * the pinned quick actions. Returns {header, kit, destroy}.
 */
export function installInspectorChrome(root, ctx = {}) {
  const doc = root.ownerDocument, panel = root.closest('.shell-panel') ?? root.parentElement ?? doc;
  const target = panel.querySelector('[data-slot=inspector-target]'), head = panel.querySelector('[data-slot=inspector-head]');
  const kit = installInspectorKit(root, {memory: inspectorSections, onScrubHint: ctx.onScrubHint, t: ctx.t});
  // The registry and its context come from the app once it has built them (a render before that shows no quick actions).
  const registry = () => { try { return ctx.commands?.() ?? globalThis.styk?.ui?.commands ?? null; } catch { return null; } };
  const commandContext = () => { try { return (ctx.commandContext ?? globalThis.styk?.ui?.context)?.(); } catch { return undefined; } };
  const header = target ? createInspectorHeader({target, head, inspector: root, registry, commandContext, t: ctx.t, pins: ctx.pins ?? (() => [])}) : null;
  const stop = onInspectorRender(descriptor => { header?.update(descriptor); queueMicrotask(kit.sync); });
  return {header, kit, destroy() { stop(); header?.destroy(); kit.destroy(); }};
}
