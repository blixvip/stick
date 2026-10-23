/**
 * What Home lists and in which order (docs/HOME.md). Pure: no DOM, no editor,
 * no desktop bridge. The project records come from the desktop's project
 * library (desktop/project-library.cjs): {id, name, filename, directory,
 * extension, pinned, folder, openedAt, modifiedAt, bytes, missing, stats,
 * hasPreview, open}.
 */
export const HOME_SORTS = Object.freeze(['recent', 'name', 'modified']);
export const HOME_LAYOUTS = Object.freeze(['grid', 'list']);

/** The scope a person browses: every project, the pinned ones, or one folder. */
export const ALL_PROJECTS = Object.freeze({kind: 'all'});
export const PINNED_PROJECTS = Object.freeze({kind: 'pinned'});
export const folderScope = name => Object.freeze({kind: 'folder', name});
export const sameScope = (a, b) => a?.kind === b?.kind && (a?.kind !== 'folder' || a.name === b.name);

/** Where a project came from, by its file's extension: the app's own format, Pivot or Stick Nodes. */
export function projectOrigin(extension = '') {
  const kind = String(extension).toLowerCase();
  return kind === 'piv' ? 'pivot' : kind === 'stknds' ? 'sticknodes' : 'styk';
}

const folded = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();

/** True when every word of `query` is in the project's name or folder, whatever the case or accents. */
export function matchesQuery(project, query) {
  const words = folded(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${folded(project.name)} ${folded(project.folder)}`;
  return words.every(word => text.includes(word));
}

export function inScope(project, scope = ALL_PROJECTS) {
  if (scope.kind === 'pinned') return Boolean(project.pinned);
  if (scope.kind === 'folder') return project.folder === scope.name;
  return true;
}

/**
 * The projects in the order Home shows them: pinned ones lead, then the
 * chosen order. `compare` compares two names (a locale's collator).
 */
export function orderProjects(projects, sort = 'recent', compare = (a, b) => a.localeCompare(b)) {
  const byName = (a, b) => compare(a.name, b.name) || a.id.localeCompare(b.id);
  const by = sort === 'name' ? byName
    : sort === 'modified' ? (a, b) => (b.modifiedAt ?? -Infinity) - (a.modifiedAt ?? -Infinity) || byName(a, b)
    : (a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || byName(a, b);
  return [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || by(a, b));
}

/** What the list shows for a scope, a search and an order. */
export function visibleProjects(projects, {scope = ALL_PROJECTS, query = '', sort = 'recent', compare} = {}) {
  return orderProjects(projects.filter(project => inScope(project, scope) && matchesQuery(project, query)), sort, compare);
}

/** The scopes above the list with how many projects each holds: All, Pinned (when any) and every folder. */
export function projectScopes(projects, folders = []) {
  const pinned = projects.filter(project => project.pinned).length;
  return [
    {scope: ALL_PROJECTS, count: projects.length},
    ...(pinned ? [{scope: PINNED_PROJECTS, count: pinned}] : []),
    ...folders.map(name => ({scope: folderScope(name), count: projects.filter(project => project.folder === name).length})),
  ];
}

/** A scope that no longer exists (its folder was deleted, the last pin removed) falls back to every project. */
export function validScope(scope, projects, folders = []) {
  if (scope?.kind === 'folder') return folders.includes(scope.name) ? scope : ALL_PROJECTS;
  if (scope?.kind === 'pinned') return projects.some(project => project.pinned) ? scope : ALL_PROJECTS;
  return ALL_PROJECTS;
}

const UNITS = [['year', 31536000000], ['month', 2592000000], ['week', 604800000], ['day', 86400000], ['hour', 3600000], ['minute', 60000]];

/**
 * A moment as "3 hours ago": {value, unit} for Intl.RelativeTimeFormat, or
 * null for something that just happened (under a minute, or in the future).
 */
export function relativeTime(time, now = Date.now()) {
  if (!Number.isFinite(time)) return null;
  const elapsed = now - time;
  if (elapsed < 60000) return null;
  for (const [unit, size] of UNITS) if (elapsed >= size) return {value: -Math.floor(elapsed / size), unit};
  return null;
}

/** How long a project plays, in seconds, from its counts; null when they are unknown. */
export function playSeconds(stats) {
  if (!stats || !(stats.fps > 0) || !Number.isFinite(stats.frames)) return null;
  return stats.frames / stats.fps;
}

/** A file size in the largest unit that keeps it readable: {value, unit} with unit 'kilobyte' or 'megabyte'. */
export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return bytes < 1024 * 1024 ? {value: Math.max(1, Math.round(bytes / 1024)), unit: 'kilobyte'} : {value: Math.round(bytes / 1024 / 1024 * 10) / 10, unit: 'megabyte'};
}

/** The tutorials with what a person finished: {items: [{...tutorial, done}], done, total, next}. `next` is the first unfinished one. */
export function tutorialProgress(tutorials, doneIds = []) {
  const finished = new Set(doneIds);
  const items = tutorials.map(tutorial => ({...tutorial, done: finished.has(tutorial.id)}));
  const done = items.filter(item => item.done).length;
  return {items, done, total: items.length, next: items.find(item => !item.done) ?? null};
}
