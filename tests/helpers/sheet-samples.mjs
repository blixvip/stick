import {sheetKeyTimes} from '../../src/layer-sheet.mjs';
import {evaluatedFrame,timeline} from '../../src/pivot/geometry.mjs';
export {sheetKeyTimes};
export function sampleSheet(report,tick) {
  const rows=timeline(report),index=Math.max(0,rows.findLastIndex(row=>row.start<=tick)),row=rows[index];
  return evaluatedFrame(report,index,row.count?(tick-row.start)/row.count:0,tick);
}
