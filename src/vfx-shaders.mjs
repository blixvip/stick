export const vfxVertex=`#version 300 es
out vec2 uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
export const vfxFragment=`#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceImage,originalImage,maskImage;
uniform vec2 dimensions,origin,outputSize;
uniform int operation,paintType,stopCount;
uniform float paintAngle,stopOffsets[32];
uniform vec4 stops[32],p,q,r;
in vec2 uv;
out vec4 pixel;
const float PI=3.141592653589793;
vec4 sampleAt(vec2 at){if(any(lessThan(at,vec2(0)))||any(greaterThan(at,vec2(1))))return vec4(0);return texture(sourceImage,at);}
vec2 globalPixel(){return vec2(uv.x,1.-uv.y)*dimensions+origin;}
vec4 sampleGlobal(vec2 at){vec2 pos=(at-origin)/dimensions;return sampleAt(vec2(pos.x,1.-pos.y));}
vec4 brush(){if(paintType==0)return stops[0];vec2 pos=globalPixel()/outputSize-.5;float cs=cos(paintAngle),sn=sin(paintAngle);pos=mat2(cs,-sn,sn,cs)*pos;float t=pos.x+.5;if(paintType==2)t=length(pos)*2.;if(paintType==3)t=fract(atan(pos.y,pos.x)/(2.*PI)+1.);if(paintType==4)t=(abs(pos.x)+abs(pos.y))*2.;vec4 a=stops[0];float offset=stopOffsets[0];for(int i=1;i<32;i++){if(i>=stopCount)break;float next=stopOffsets[i];if(t<next)return mix(a,stops[i],clamp((t-offset)/max(.00001,next-offset),0.,1.));a=stops[i];offset=next;}return a;}
uint hashValue(uint n){n^=n>>16u;n*=0x7feb352du;n^=n>>15u;n*=0x846ca68bu;n^=n>>16u;return n;}
float hashPoint(vec2 xy,float seed){uvec2 v=uvec2(ivec2(floor(xy)));return float(hashValue(v.x*1973u+v.y*9277u+uint(seed)*26699u)&65535u)/65535.;}
float noiseAt(vec2 pos,float seed,float smoothness){vec2 i=floor(pos),f=fract(pos);f=mix(vec2(0),f*f*(3.-2.*f),smoothness);return mix(mix(hashPoint(i,seed),hashPoint(i+vec2(1,0),seed),f.x),mix(hashPoint(i+vec2(0,1),seed),hashPoint(i+1.,seed),f.x),f.y);}
void main(){
 vec4 c=sampleAt(uv);vec3 rgb=c.a>.000001?c.rgb/c.a:vec3(0);
 if(operation==1){vec4 b=brush();pixel=vec4(mix(rgb,b.rgb,p.x*b.a)*c.a,c.a);return;}
 if(operation==2){rgb*=exp2(p.x);rgb=(rgb-.5)*p.y+.5;float l=dot(rgb,vec3(.2126,.7152,.0722));rgb=mix(vec3(l),rgb,p.z);rgb+=vec3(p.w*.12,q.x*.12,-p.w*.12);rgb+=q.y*pow(1.-clamp(l,0.,1.),2.)*.4+q.z*pow(clamp(l,0.,1.),2.)*.4;rgb=pow(max(rgb,vec3(0)),vec3(1./q.w));pixel=vec4(clamp(rgb,0.,1.)*c.a,c.a);return;}
 if(operation==3||operation==4){vec2 delta=operation==3?vec2(1./dimensions.x,0):vec2(0,1./dimensions.y);vec4 sum=vec4(0);int radius=clamp(int(p.x),0,128);for(int i=-radius;i<=radius;i++)sum+=sampleAt(uv+delta*float(i));pixel=sum/float(radius*2+1);return;}
 if(operation==5||operation==6){vec2 delta=operation==5?vec2(1./dimensions.x,0):vec2(0,1./dimensions.y);float alpha=0.;int radius=clamp(int(p.x),0,128);for(int i=-radius;i<=radius;i++)alpha=max(alpha,sampleAt(uv+delta*float(i)).a);pixel=vec4(alpha);return;}
 if(operation==7){vec4 front=texture(originalImage,uv),b=brush();float a=clamp(pow(sampleAt(uv-vec2(q.x,-q.y)/dimensions).a,p.y)*p.x*b.a,0.,1.);if(p.z>0.){vec3 rgb=mix(front.rgb,b.rgb*front.a,a);if(p.w==1.)rgb=min(front.rgb+b.rgb*front.a*a,vec3(front.a));if(p.w==2.)rgb=front.rgb+b.rgb*a*(front.a-front.rgb);pixel=vec4(rgb,front.a);return;}vec4 under=vec4(b.rgb*a,a);pixel=front+under*(1.-front.a);if(p.w==1.)pixel=vec4(min(front.rgb+under.rgb,vec3(max(front.a,a))),max(front.a,a));if(p.w==2.)pixel=vec4(front.rgb+under.rgb-front.rgb*under.rgb,max(front.a,a));return;}
 if(operation==8){vec2 xy=globalPixel(),size=p.xy;vec2 cell=clamp((floor((xy-q.xy)/size)+.5)*size+q.xy,vec2(.5),outputSize-.5);pixel=sampleGlobal(cell);return;}
 if(operation==9){vec2 xy=globalPixel()/p.y;float seed=p.z+p.w,smoothness=max(q.z,q.w),n=noiseAt(xy,seed,smoothness)-.5;vec3 grain=q.x>0.?vec3(n,noiseAt(xy,seed+131.,smoothness)-.5,noiseAt(xy,seed+719.,smoothness)-.5):vec3(n);pixel=vec4(clamp(rgb+grain*p.x*q.y,0.,1.)*c.a,c.a);return;}
 if(operation==10){vec2 xy=(globalPixel()/outputSize-q.xy)*2.;xy.x/=q.z;float distance=mix(max(abs(xy.x),abs(xy.y)),length(xy)/1.41421356237,q.w)/p.z;float dark=smoothstep(1.-p.y,1.,distance)*p.x;vec4 b=brush();pixel=vec4(mix(c.rgb,b.rgb*c.a,dark*b.a),c.a);return;}
 if(operation==11){vec2 xy=(vec2(gl_FragCoord.x,p.w-gl_FragCoord.y)*p.x-p.yz)/dimensions;pixel=sampleAt(vec2(xy.x,1.-xy.y));return;}
 if(operation==12){vec2 xy=(vec2(gl_FragCoord.x,p.w-gl_FragCoord.y)+p.yz)/p.x/dimensions;pixel=sampleAt(vec2(xy.x,1.-xy.y));return;}
 if(operation==13){pixel=vec4(1.-c.a);return;}
 if(operation==14){float a=c.a;for(int i=0;i<16;i++){float angle=float(i)*PI/8.;a=max(a,sampleAt(uv+vec2(cos(angle),sin(angle))*p.x/dimensions).a);}pixel=vec4(a);return;}
 if(operation==15){vec4 front=texture(originalImage,uv),b=brush();float a=p.y>0.?c.a*front.a:max(0.,c.a-front.a);a*=p.x*b.a;if(p.z>0.)pixel=vec4(b.rgb*a,a);else if(p.y>0.)pixel=vec4(mix(front.rgb,b.rgb*front.a,clamp(c.a*p.x*b.a,0.,1.)),front.a);else pixel=front+vec4(b.rgb*a,a)*(1.-front.a);return;}
 if(operation==16){vec2 xy=globalPixel(),delta=xy-q.xy*outputSize,dir=p.y==1.?vec2(cos(p.z),sin(p.z)):normalize(delta+vec2(.00001));if(p.y==3.)dir=vec2(-dir.y,dir.x);vec4 sum=vec4(0);for(int i=0;i<33;i++){float t=float(i)/32.-.5;sum+=sampleGlobal(xy+dir*p.x*t*2.);}pixel=sum/33.;return;}
 if(operation==17){float n=noiseAt(globalPixel()/p.y,p.w,1.);float keep=p.x<=0.?1.:p.x>=1.?0.:smoothstep(p.x-p.z,p.x+p.z,n);float edge=(1.-smoothstep(p.x,p.x+q.x+p.z,n))*keep;vec4 b=brush();pixel=vec4(mix(c.rgb,b.rgb*c.a,edge*b.a)*keep,c.a*keep);return;}
 if(operation==18){vec2 delta=vec2(cos(p.y),sin(p.y))*p.x,xy=globalPixel();vec4 red=sampleGlobal(xy+delta*q.x),green=sampleGlobal(xy+delta*q.y),blue=sampleGlobal(xy+delta*q.z);float alpha=max(red.a,max(green.a,blue.a));pixel=vec4(red.r,green.g,blue.b,alpha);return;}
 if(operation==19){vec2 axis=vec2(cos(p.z),sin(p.z)),xy=globalPixel();float wave=sin(dot(xy,axis)*2.*PI/p.y+p.w);pixel=sampleGlobal(xy+vec2(-axis.y,axis.x)*wave*p.x);return;}
 if(operation==20){vec2 xy=globalPixel(),delta=xy-q.xy*outputSize;float distance=length(delta),ring=(distance-p.x)/p.y;float strength=sin(ring*PI)*pow(max(0.,1.-abs(ring)),p.w)*p.z;pixel=sampleGlobal(xy+delta/max(.0001,distance)*strength);return;}
 if(operation==21){float l=max(rgb.r,max(rgb.g,rgb.b)),mask=smoothstep(p.x-p.y,p.x+p.y,l);pixel=c*mask;return;}
 if(operation==22){vec4 front=texture(originalImage,uv),b=brush();pixel=vec4(min(front.rgb+c.rgb*b.rgb*b.a*p.x,vec3(max(front.a,c.a))),max(front.a,c.a));return;}
 if(operation==23){vec2 xy=globalPixel()/outputSize-.5;float position=dot(xy,vec2(cos(p.y),sin(p.y)))+.5,distance=abs(position-p.x)*2./p.z,light=1.-smoothstep(1.-p.w,1.,distance);vec4 b=brush();pixel=vec4(clamp(c.rgb+b.rgb*b.a*light*q.x*c.a,0.,c.a),c.a);return;}
 if(operation==24){vec2 xy=globalPixel(),pos=xy/outputSize*2.-1.;vec2 warped=(pos*(1.+p.z*dot(pos,pos))*.5+.5)*outputSize;vec4 s=sampleGlobal(warped);if(any(lessThan(warped,vec2(0)))||any(greaterThanEqual(warped,outputSize)))s=vec4(0);if(p.w>0.){s.r=sampleGlobal(warped+vec2(p.w,0)).r;s.b=sampleGlobal(warped-vec2(p.w,0)).b;s.rgb=min(s.rgb,vec3(s.a));}float line=(.5+.5*cos((xy.y+q.x)*2.*PI/p.y))*p.x;vec4 b=brush();pixel=vec4(mix(s.rgb,b.rgb*s.a,line*b.a),s.a);return;}
 if(operation==25){vec4 front=texture(originalImage,uv),inner=texture(maskImage,uv),b=brush();float outer=max(0.,c.a-front.a)*p.x*b.a;vec4 ring=inner+vec4(b.rgb*outer,outer)*(1.-inner.a);pixel=p.y>0.?ring:ring+front*(1.-ring.a);return;}
 if(operation==26){pixel=mix(texture(originalImage,uv),c,p.x);return;}
 if(operation==27){vec2 xy=globalPixel()/p.y+vec2(p.z*.73,p.z*1.17),offset=vec2(0);float weight=1.,total=0.;for(int i=0;i<4;i++){if(float(i)>=q.x)break;offset+=vec2(noiseAt(xy,p.w+float(i)*37.,1.),noiseAt(xy+vec2(19.1,7.7),p.w+131.+float(i)*37.,1.))*weight;total+=weight;weight*=.5;xy*=2.;}pixel=sampleGlobal(globalPixel()+(offset/total*2.-1.)*p.x);return;}
 pixel=c;
}`;
