(() => {
const el=id=>({textContent:window.plusAssets[id]});
let workerPromise;
function engine(){
 if(!window.Worker||!window.WebAssembly)throw Error('Browser settings block local OCR. Try an approved Chrome or Edge profile.');
 if(!workerPromise){
  const decode=id=>Uint8Array.from(atob(el(id).textContent),c=>c.charCodeAt(0));
  const url=URL.createObjectURL(new Blob([decode('workerData')],{type:'text/javascript'}));
  workerPromise=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Local OCR could not start. Browser policy may block workers or WebAssembly.')),45000);
   Tesseract.createWorker([{code:'eng',data:decode('modelData')}],1,{workerPath:url,workerBlobURL:false,cacheMethod:'none',errorHandler:reject})
    .then(resolve,reject).finally(()=>{clearTimeout(timer);URL.revokeObjectURL(url)});
  }).catch(e=>{workerPromise=null;throw e});
 }
 return workerPromise;
}
function prepare(image,region,scale,contrast){
 const c=document.createElement('canvas'), pad=region?12:0;
 const r=region||{x:0,y:0,w:image.naturalWidth,h:image.naturalHeight};
 scale=Math.min(scale,Math.sqrt(16000000/(r.w*r.h)),10000/Math.max(r.w,r.h));
 const w=Math.max(1,Math.round(r.w*scale)),h=Math.max(1,Math.round(r.h*scale));
 c.width=w+2*pad;c.height=h+2*pad;
 const g=c.getContext('2d');g.fillStyle='white';g.fillRect(0,0,c.width,c.height);
 g.imageSmoothingQuality='high';if(contrast)g.filter='contrast(1.35)';
 g.drawImage(image,r.x,r.y,r.w,r.h,pad,pad,w,h);
 return {canvas:c,map:b=>({x:r.x+(b.x0-pad)*r.w/w,y:r.y+(b.y0-pad)*r.h/h,
  right:r.x+(b.x1-pad)*r.w/w,bottom:r.y+(b.y1-pad)*r.h/h})};
}
// LSTM sometimes reports a joined pair with overlapping boxes. Bound the shared
// edge by the overlap and the relative advances of the two recognized glyphs.
const metrics=document.createElement('canvas').getContext('2d');
metrics.font='40px Arial';
function resolveOverlap(symbols){
 for(let i=1;i<symbols.length;i++){
  const left=symbols[i-1],right=symbols[i];
  if(right.x>=left.right || right.right<=left.x)continue;
  const a=metrics.measureText(left.text).width,b=metrics.measureText(right.text).width;
  const estimate=left.x+(right.right-left.x)*a/Math.max(1,a+b);
  const edge=Math.max(right.x,Math.min(left.right,estimate));
  left.right=edge;right.x=edge;
 }
}
// A photograph with shading benefits from local background removal.
// Keep flat screenshots and white scans on the original fast path.
function hasShadedBackground(image) {
 const sample=document.createElement('canvas');
 sample.width=48; sample.height=36;
 const context=sample.getContext('2d');
 context.drawImage(image,0,0,sample.width,sample.height);
 const pixels=context.getImageData(0,0,sample.width,sample.height).data;
 const histogram=new Uint32Array(256);
 for(let i=0;i<pixels.length;i+=4){
  histogram[Math.round(.3*pixels[i]+.59*pixels[i+1]+.11*pixels[i+2])]++;
 }
 let total=0,lower=0,upper=0;
 for(let i=0;i<256;i++){
  total+=histogram[i];
  if(total<sample.width*sample.height*.15)lower=i;
  if(total<sample.width*sample.height*.85)upper=i;
 }
 return upper<238 && upper-lower>28;
}

function removeLargeGraphics(pixels,mask,width,height){
 const component=new Int32Array(mask.length);
 const maxWidth=Math.max(70,width*.08),maxHeight=Math.max(60,height*.08);
 for(let start=0;start<mask.length;start++){
  if(mask[start]!==1)continue;
  let count=1,left=width,right=0,top=height,bottom=0;
  component[0]=start;mask[start]=2;
  function enqueue(i){if(mask[i]===1){mask[i]=2;component[count++]=i}}
  for(let j=0;j<count;j++){
   const i=component[j],x=i%width,y=Math.floor(i/width);
   left=Math.min(x,left);right=Math.max(x,right);top=Math.min(y,top);bottom=Math.max(y,bottom);
   if(x>0)enqueue(i-1);
   if(x+1<width)enqueue(i+1);
   if(y>0)enqueue(i-width);
   if(y+1<height)enqueue(i+width);
  }
  if(count>1 && right-left<=maxWidth && bottom-top<=maxHeight)continue;
  for(let j=0;j<count;j++){const i=4*component[j];pixels[i]=pixels[i+1]=pixels[i+2]=255}
 }
}

function preparePhoto(image,gain=5){
 const reduction=Math.min(1,Math.sqrt(2000000/(image.naturalWidth*image.naturalHeight)),2200/Math.max(image.naturalWidth,image.naturalHeight));
 const base=document.createElement('canvas');
 const w=base.width=Math.max(1,Math.round(image.naturalWidth*reduction));
 const h=base.height=Math.max(1,Math.round(image.naturalHeight*reduction));
 const context=base.getContext('2d',{willReadFrequently:true});
 context.drawImage(image,0,0,w,h);
 const raster=context.getImageData(0,0,w,h),pixels=raster.data;
 const gray=new Uint8Array(w*h),sum=new Float64Array((w+1)*(h+1)),mask=new Uint8Array(w*h);
 for(let y=0;y<h;y++){
  let row=0;
  for(let x=0;x<w;x++){
   const i=y*w+x,k=i*4;
   gray[i]=.30*pixels[k]+.59*pixels[k+1]+.11*pixels[k+2];
   row+=gray[i];sum[(y+1)*(w+1)+x+1]=sum[y*(w+1)+x+1]+row;
  }
 }
 for(let y=0;y<h;y++){
  const top=Math.max(0,y-10),bottom=Math.min(h,y+11);
  for(let x=0;x<w;x++){
   const left=Math.max(0,x-10),right=Math.min(w,x+11),i=y*w+x;
   const localSum=sum[bottom*(w+1)+right]-sum[top*(w+1)+right]-sum[bottom*(w+1)+left]+sum[top*(w+1)+left];
   const background=localSum/((bottom-top)*(right-left));
   const value=Math.max(0,Math.min(255,255-(background-gray[i]-5)*gain));
   pixels[4*i]=pixels[4*i+1]=pixels[4*i+2]=value;mask[i]=value<170?1:0;
  }
 }
 removeLargeGraphics(pixels,mask,w,h);
 context.putImageData(raster,0,0);
 const canvas=document.createElement('canvas');canvas.width=Math.round(w*2);canvas.height=Math.round(h*2);
 const g=canvas.getContext('2d');g.imageSmoothingQuality='high';g.drawImage(base,0,0,canvas.width,canvas.height);
 const sx=image.naturalWidth/canvas.width,sy=image.naturalHeight/canvas.height;
 return {canvas,map:b=>({x:b.x0*sx,y:b.y0*sy,right:b.x1*sx,bottom:b.y1*sy})};
}

async function recognize(image,region=null,mode='normal'){
 if(region){
  if(region.h>2*region.w || hasShadedBackground(image))return retryReading(image,region);
  return cropPass(image,region,'plain');
 }
 const photo=mode==='normal' && hasShadedBackground(image);
 const p=photo?preparePhoto(image):prepare(image,null,mode==='enhanced'?2:1,mode==='enhanced');
 const lines=await readRaster(p,mode==='baseline'?'6':'11');
 return photo?refinePhoto(image,lines):lines;
}
async function readRaster(p,segmentation){
 const worker=await engine();
 await worker.setParameters({tessedit_pageseg_mode:segmentation,tessedit_char_whitelist:''});
 const {data}=await worker.recognize(p.canvas,{},{blocks:true});
 p.canvas.width=p.canvas.height=1;
 const lines=[];
 for(const block of data.blocks||[])for(const par of block.paragraphs)for(const row of par.lines){
  let segment=[];
  for(const word of row.words){
   const box=p.map(word.bbox);
   if(segment.length && box.x-segment.at(-1).right>2.2*Math.max(6,box.bottom-box.y)){lines.push(segment);segment=[]}
   const symbols=(word.symbols||[]).map(s=>({...p.map(s.bbox),text:s.text}));
   if(!p.rotation)resolveOverlap(symbols);
   if(symbols.length)segment.push({...box,rotation:p.rotation||0,confidence:word.confidence,text:symbols.map(s=>s.text).join(''),symbols});
  }
  if(segment.length)lines.push(segment);
 }
 return lines;
}
function boostInk(canvas,mode){
 const g=canvas.getContext('2d',{willReadFrequently:true});
 const frame=g.getImageData(0,0,canvas.width,canvas.height),a=frame.data;
 const histogram=new Uint32Array(256);
 for(let i=0;i<a.length;i+=4)histogram[Math.round(.3*a[i]+.59*a[i+1]+.11*a[i+2])]++;
 function percentile(q){let count=0;for(let n=0;n<256;n++){count+=histogram[n];if(count>=a.length/4*q)return n}return 255}
 const low=percentile(.02),high=percentile(.7);
 for(let i=0;i<a.length;i+=4){const value=.3*a[i]+.59*a[i+1]+.11*a[i+2];
  const gray=mode==='dark'?(value-low-10)*7:(value-low)*255/Math.max(1,high-low);
  a[i]=a[i+1]=a[i+2]=gray;
 }
 g.putImageData(frame,0,0);
}

async function cropPass(image,region,mode,rotation=0){
 const p=prepare(image,region,3,false);
 if(mode!=='plain')boostInk(p.canvas,mode);
 if(!rotation)return readRaster(p,'7');
 const source=p.canvas,rotated=document.createElement('canvas');
 rotated.width=source.height;rotated.height=source.width;
 const g=rotated.getContext('2d');
 g.translate(rotation>0?rotated.width:0,rotation>0?0:rotated.height);
 g.rotate(rotation*Math.PI/2);g.drawImage(source,0,0);
 const height=source.height,width=source.width;source.width=source.height=1;
 const unrotate=b=>rotation>0?{x0:b.y0,y0:height-b.x1,x1:b.y1,y1:height-b.x0}:{x0:width-b.y1,y0:b.x0,x1:width-b.y0,y1:b.x1};
 const lines=await readRaster({canvas:rotated,map:b=>p.map(unrotate(b)),rotation},'7');
 return lines;
}

function confidence(lines){
 const words=lines.flat();if(!words.length)return 0;
 return words.reduce((s,w)=>s+w.confidence*w.symbols.length,0)/words.reduce((s,w)=>s+w.symbols.length,0);
}
async function retryReading(image,region){
 const vertical=region.h>2*region.w;
 const angles=vertical?[1,-1]:[0];
 let best=[],score=-1;
 for(const rotation of angles){
  for(const mode of ['plain','contrast','dark']){
   const candidate=await cropPass(image,region,mode,rotation);
   const quality=confidence(candidate);
   if(quality>score){score=quality;best=candidate}
   if(quality>=94)break;
  }
  if(score>=90)break;
 }
 return best;
}

function agreementRepair(lines,alternate){
 const alternatives=alternate.flat();
 // Separate OCR rows can contain fragments of a single printed word.
 for(const whole of alternatives){
  if(whole.confidence<85 || whole.text.length<3)continue;
  const parts=[];
  for(const row of lines)for(const w of row){
   if(w.x>=whole.x-3 && w.right<=whole.right+3 && Math.abs(w.y-whole.y)<4 && Math.abs(w.bottom-whole.bottom)<6)parts.push({row,w});
  }
  parts.sort((a,b)=>a.w.x-b.w.x);
  if(parts.length<2 || parts.map(p=>p.w.text).join('')!==whole.text)continue;
  const first=parts.shift();first.row[first.row.indexOf(first.w)]=whole;
  for(const {row,w} of parts)row.splice(row.indexOf(w),1);
 }
 for(const line of lines){
  for(let i=0;i<line.length;i++){
   const word=line[i],next=line[i+1];
   const matches=alternatives.filter(other=>Math.abs(other.x-word.x)<4 && Math.abs(other.bottom-word.bottom)<4);
   if(next && next.x-word.right<.35*(word.bottom-word.y)){
    const joined=matches.find(w=>w.confidence>=85 && w.text===word.text+next.text && Math.abs(w.right-next.right)<4);
    if(joined){line.splice(i,2,joined);continue}
   }
   if(word.confidence>=70)continue;
   const better=alternatives.find(w=>{
    const intersection=Math.max(0,Math.min(w.right,word.right)-Math.max(w.x,word.x))*Math.max(0,Math.min(w.bottom,word.bottom)-Math.max(w.y,word.y));
    const area=(w.right-w.x)*(w.bottom-w.y);
    return w.confidence>=88&&area>0&&intersection>.8*area&&w.x>=word.x-5&&w.right<=word.right+5;
   });
   if(better)line[i]=better;
  }
 }
}

async function refinePhoto(image,lines){
 const alternate=await readRaster(preparePhoto(image,2),'11');
 agreementRepair(lines,alternate);
 const heights=lines.flat().filter(w=>w.confidence>=85).map(w=>w.bottom-w.y).sort((a,b)=>a-b);
 if(!heights.length)return lines;
 const height=heights[Math.floor(heights.length/2)];
 let budget=18;
 for(const line of lines){
  for(let i=0;i<line.length && budget>0;i++){
   const word=line[i];let anchor=word;
   if(word.confidence<65 && word.bottom-word.y>height*1.9){
    anchor=alternate.flat().find(w=>w.confidence>=35 && w.x>=word.x-3 && w.right<=word.right+3 && Math.abs(w.y-word.y)<height*.5 && w.bottom-w.y<height*1.5 && /[a-z0-9]{2}/i.test(w.text))||word;
   }
   const h=anchor.bottom-anchor.y,w=anchor.right-anchor.x;
   if(word.confidence>=75 || !/[a-z0-9]{2}/i.test(word.text)||h<height*.55||h>height*1.9||w<.8*h)continue;
   const pad=Math.max(3,h*.22),x=Math.max(0,anchor.x-pad),y=Math.max(0,anchor.y-pad);
   const region={x,y,w:Math.min(image.naturalWidth,anchor.right+pad)-x,h:Math.min(image.naturalHeight,anchor.bottom+pad)-y};
   budget--;const candidate=(await retryReading(image,region)).flat();
   if(candidate.length===1&&(anchor===word || candidate[0].text===anchor.text)&&candidate[0].confidence>=82 && candidate[0].confidence>=word.confidence+10)line[i]=candidate[0];
  }
 }
 return lines;
}

function bounds(items){return {x:Math.min(...items.map(w=>w.x)),y:Math.min(...items.map(w=>w.y)),right:Math.max(...items.map(w=>w.right)),bottom:Math.max(...items.map(w=>w.bottom))}}

window.plusScan=async image=>(await recognize(image)).map(line=>line.map(w=>({rotation:w.rotation||0,text:w.text,left:w.x,top:w.y,width:w.right-w.x,height:w.bottom-w.y,chars:w.symbols.map(c=>({text:c.text,left:c.x,top:c.y,width:c.right-c.x,height:c.bottom-c.y}))})));
})();
