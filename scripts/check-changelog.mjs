import { checkReleaseNotes } from './changelog.mjs';
await checkReleaseNotes();
console.log('Changelog order, duplicate entries, versions, and generated notes verified.');
