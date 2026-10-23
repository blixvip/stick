/** Read-only input inventory for the full animation performance benchmark. */
import {createReadStream} from 'node:fs';
import {readdir,stat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const root=path.resolve(process.argv[2]||'');
if(!process.argv[2])throw new Error('Provide the folder containing the PIV benchmark inputs.');
const output=path.resolve('artifacts/animation-corpus-60'),files=[];
async function visit(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const filename=path.join(directory,entry.name);
    if(entry.isDirectory())await visit(filename);
    else if(entry.isFile()&&/\.piv$/i.test(entry.name)){
      const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);
      files.push({path:filename,relative:path.relative(root,filename),bytes:(await stat(filename)).size,sha256:hash.digest('hex')});
    }
  }
}
await visit(root);files.sort((a,b)=>a.relative.localeCompare(b.relative));
await mkdir(output,{recursive:true});await writeFile(path.join(output,'inventory.json'),JSON.stringify({root,files},null,2));
console.log(JSON.stringify({files:files.length,unique:new Set(files.map(f=>f.sha256)).size,bytes:files.reduce((n,f)=>n+f.bytes,0),output}));
