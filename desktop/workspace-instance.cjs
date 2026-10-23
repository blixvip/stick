'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Secondary windows own recovery and Chromium session files. Reuse an inactive
// process's directory so recovery remains discoverable after a crash/restart.
function workspaceDirectory(profile, {pid = process.pid, alive = processAlive} = {}) {
  const root = path.join(profile, 'workspaces'), directory = path.join(root, String(pid));
  fs.mkdirSync(root, {recursive:true});
  if (fs.existsSync(directory)) return directory;
  for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name) || alive(Number(entry.name))) continue;
    try { fs.renameSync(path.join(root, entry.name), directory); return directory; }
    catch (error) { if (!['ENOENT', 'EEXIST', 'EPERM', 'EBUSY'].includes(error.code)) throw error; }
  }
  fs.mkdirSync(directory, {recursive:true}); return directory;
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
module.exports = {workspaceDirectory};
