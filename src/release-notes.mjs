const categories = new Set(['Added','Changed','Fixed','Performance','Removed','Security']);

// Published Markdown is displayed only as text, never as HTML or remote links.
export function parseReleaseNotes(markdown = '') {
  const groups = [], clean = value => value.replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'').trim();
  let title = '', group;
  for (const line of String(markdown).slice(0,16000).split(/\r?\n/)) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line.trim());
    if (heading && categories.has(heading[1])) {group = {name:heading[1],notes:[]};groups.push(group);continue;}
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!group) {group={name:'Changes',notes:[]};groups.push(group);}
      if (group.notes.length<150) group.notes.push(clean(bullet[1]));
    } else if (!title && !groups.length && line.trim() && !line.trim().startsWith('#')) title=clean(line);
  }
  return {title,groups:groups.filter(group=>group.notes.length)};
}
