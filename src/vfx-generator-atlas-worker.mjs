/** Generates particle material rows off the UI thread (see prewarmAtlas). */
import {atlasRow} from './vfx-generator-atlas.mjs';

self.onmessage=({data})=>{
 for(const row of data.rows){const {levels}=atlasRow(row);self.postMessage({row,levels},levels.map(level=>level.data.buffer));}
 self.postMessage({done:true});
};
