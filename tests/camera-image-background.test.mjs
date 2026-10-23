import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundImageTiles, backgroundImageRaster} from '../src/pivot/background.mjs';

test('image edges preserve top-left cover placement and use decoded preview pixels', () => {
  for (const [width,height] of [[1920,1080],[1080,1920]]) {
    const bounds={x:-400,y:-300,width:2200,height:1800};
    const tiles=backgroundImageTiles(960,540,width,height,bounds,width/2,height/2);
    const scale=Math.max(960/width,540/height);
    assert.ok(tiles.length<=9);
    assert.ok(tiles.some(t=>t[4]===0&&t[5]===0&&t[6]===width*scale&&t[7]===height*scale));
    for (const [sx,sy,sw,sh] of tiles) {
      assert.ok(sx>=0&&sy>=0&&sx+sw<=width/2&&sy+sh<=height/2);
    }
  }
});

test('extreme camera extents use bounded, aligned temporary rasters', () => {
  for(const bounds of [
    {x:-.5,y:-.25,width:1000,height:600},
    {x:-1e8,y:-2e8,width:3e8,height:4e8},
    {x:1e8,y:1e8,width:1000,height:600},
    {x:-10,y:-10,width:1e8,height:1},
  ]) {
    const raster=backgroundImageRaster(960,540,8000,6000,bounds);
    assert.ok(raster.pixelWidth<=16384&&raster.pixelHeight<=16384);
    assert.ok(raster.pixelWidth*raster.pixelHeight<=32*1024*1024);
    assert.ok(raster.x<=bounds.x&&raster.y<=bounds.y);
    assert.ok(raster.x+raster.width>=bounds.x+bounds.width-1e-6);
    assert.ok(raster.y+raster.height>=bounds.y+bounds.height-1e-6);
    for(const tile of raster.tiles) assert.ok(tile.slice(4).every(Number.isInteger));
  }
});
