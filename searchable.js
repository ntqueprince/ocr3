/* All geometry is in the OCR raster, never in preview/CSS coordinates. */
function hasExifRotation(bytes) {
  const d=new DataView(bytes);let offset=2;
  while(offset+4<d.byteLength && d.getUint8(offset)===255){
    const marker=d.getUint8(offset+1);if(marker===218||marker===217)break;
    const size=d.getUint16(offset+2);if(size<2||offset+2+size>d.byteLength)break;
    if(marker===225 && size>=16 && d.getUint32(offset+4)===0x45786966){
      const t=offset+10,little=d.getUint16(t)===0x4949;
      const ifd=t+d.getUint32(t+4,little);
      if(ifd+2<=offset+2+size){
        const count=d.getUint16(ifd,little);
        for(let i=0;i<count;i++){const p=ifd+2+i*12;if(p+12>offset+2+size)break;
          if(d.getUint16(p,little)===274)return d.getUint16(p+8,little)!==1;
        }
      }
    }
    offset+=2+size;
  }
  return false;
}
async function pdfReader() {
  await localScript('pdf-reader-worker');
  await localScript('pdf-reader');
  await localScript('pdf-font-data');
  return window.pdfjsLib;
}
async function openPdfRasterPages(file) {
  const lib = await pdfReader(), bytes = new Uint8Array(await file.arrayBuffer());
  // Keep separate bytes: PDF.js transfers its input to its worker.
  const source = await PDFDocument.load(bytes.slice());
  const decode=name=>{
    const data=window.pdfFontData[name];if(!data)throw Error('Missing bundled PDF font/CMap: '+name);
    return Uint8Array.from(atob(data),c=>c.charCodeAt(0));
  };
  const task = lib.getDocument({data: bytes.slice(), isEvalSupported:false,useWorkerFetch:false,
    CMapReaderFactory:class {async fetch({name}){return {cMapData:decode(name+'.bcmap'),compressionType:1};}},
    StandardFontDataFactory:class {async fetch({filename}){return decode(filename);}}});
  const doc = await task.promise, pages = [];
  try {
    for (let index=0; index<doc.numPages; index++) {
      progress(index/doc.numPages*65, `Opening PDF page ${index+1}/${doc.numPages}…`);
      const original = await doc.getPage(index+1), unit = original.getViewport({scale:1});
      const scale = Math.min(2, Math.sqrt(16000000/(unit.width*unit.height)));
      const viewport = original.getViewport({scale});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await original.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const content = await original.getTextContent();
      const native = content.items.filter(item=>item.str?.trim()).map(item=>{
        const m=lib.Util.transform(viewport.transform,item.transform);
        const length=Math.hypot(m[0],m[1])||1, advance=item.width*scale;
        const dx=m[0]/length*advance,dy=m[1]/length*advance;
        const xs=[m[4],m[4]+dx,m[4]+m[2],m[4]+dx+m[2]],ys=[m[5],m[5]+dy,m[5]+m[3],m[5]+dy+m[3]];
        return {text:item.str,left:Math.min(...xs),top:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
      });
      const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PDF page could not be rendered.')),'image/png'));
      const p=await imageFileToPage(new File([blob],`${file.name} · ${index+1}.png`,{type:'image/png'}));
      p.pdfSource=source; p.pdfIndex=index; p.pdfViewport=viewport;
      p.nativeItems=native; p.pdfUnit=unit;
      pages.push(p); original.cleanup();
    }
  } finally {await doc.destroy();}
  return pages;
}

// Word-only engines: proportional advances, refined to nearby inter-glyph ink
// valleys. Never infer or replace recognized letters from an identifier pattern.
function exportCharacters(word, context) {
  if(word.chars?.length && word.chars.map(c=>c.text).join('')===word.text) {
    return word.chars.flatMap(c=>Array.from(c.text).length>1?exportCharacters({...c,chars:null},context):[c]);
  }
  const letters=Array.from(word.text), metrics=measureContext;
  metrics.font=`${Math.max(1,word.height)}px Arial`;
  const widths=letters.map(c=>metrics.measureText(c).width), total=widths.reduce((a,b)=>a+b,0)||1;
  let pixels=null, x=Math.max(0,Math.floor(word.left)), y=Math.max(0,Math.floor(word.top));
  try {pixels=context?.getImageData(x,y,Math.max(1,Math.ceil(word.width)),Math.max(1,Math.ceil(word.height)));}catch{}
  const edges=[word.left];let advance=0;
  for(let i=0;i<letters.length-1;i++) {
    advance+=widths[i];let edge=word.left+word.width*advance/total;
    if(pixels){
      const center=edge-x, radius=Math.max(1,Math.min(widths[i],widths[i+1])*word.width/total*.22);
      let best=Infinity;
      for(let col=Math.max(1,Math.floor(center-radius));col<Math.min(pixels.width-1,center+radius);col++){
        let ink=0;for(let row=0;row<pixels.height;row++){const k=4*(row*pixels.width+col);ink+=255-(pixels.data[k]+pixels.data[k+1]+pixels.data[k+2])/3;}
        const score=ink+Math.abs(col-center)*2;
        if(score<best){best=score;edge=x+col;}
      }
    }
    edges.push(Math.max(edges.at(-1)+.01,edge));
  }
  edges.push(word.left+word.width);
  return letters.map((text,i)=>({text,left:edges[i],top:word.top,width:edges[i+1]-edges[i],height:word.height}));
}
function coveredByNative(word, native) {
  // Region based, not page based: a page number/header does not suppress OCR
  // elsewhere on a scanned page. Existing text wins in overlapping regions.
  const covered=(native||[]).reduce((sum,n)=>{
    const area=Math.max(0,Math.min(word.left+word.width,n.left+n.width)-Math.max(word.left,n.left))*
      Math.max(0,Math.min(word.top+word.height,n.top+n.height)-Math.max(word.top,n.top));
    return sum+area;
  },0);
  return covered/Math.max(1,word.width*word.height)>.45;
}
async function addSearchableLayer(pdf, page, p, matrix) {
  const lib=window.PDFLib, font=await pdf.embedFont(lib.StandardFonts.Helvetica);
  const fontKey=page.node.newFontDictionary('OCR',font.ref);
  let context=null;
  if(p.ocrItems?.some(w=>!w.chars?.length)){
    const image=await getImage(p.file),c=document.createElement('canvas');
    c.width=p.processedImgWidth;c.height=p.processedImgHeight;
    context=c.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,c.width,c.height);
  }
  const ops=[lib.pushGraphicsState(),lib.concatTransformationMatrix(...matrix),lib.beginText(),
    lib.setFontAndSize(fontKey,1),lib.setTextRenderingMode(3)];
  for(const originalWord of p.ocrItems||[]) {
    if(coveredByNative(originalWord,p.nativeItems))continue;
    const rotation=originalWord.rotation||0;
    const turn=c=>rotation>0?{...c,left:-c.top-c.height,top:c.left,width:c.height,height:c.width}:
      {...c,left:c.top,top:-c.left-c.width,width:c.height,height:c.width};
    const word=rotation?{...turn(originalWord),chars:originalWord.chars?.map(turn)}:originalWord;
    const inkBoxes=word.chars?.length && word.chars.map(c=>c.text).join('')===word.text;
    const chars=exportCharacters(word,context);
    for(let i=0;i<chars.length;i++){
      const c=chars[i]; if(!c.text || c.width<=0 || c.height<=0)continue;
      // Half the inter-glyph gap belongs to each neighboring character. These
      // contiguous cells avoid artificial spaces inside chassis numbers.
      // OCR boxes bound dark ink, while a mouse drag often starts just outside
      // that ink. A small outer bearing keeps the first/last glyph selectable
      // without capturing the viewer's inferred inter-word whitespace.
      const left=i?(chars[i-1].left+chars[i-1].width+c.left)/2:c.left-(inkBoxes?word.height*.25:0);
      const right=i+1<chars.length?(c.left+c.width+chars[i+1].left)/2:c.left+c.width+(inkBoxes?word.height*.1:0);
      const size=word.height/.718, bottom=word.top+word.height;
      const advance=font.widthOfTextAtSize(c.text,1);
      const a=(right-left)/Math.max(.001,advance);
      const tm=rotation>0?[0,-a,-size,0,bottom,-left]:rotation<0?[0,a,size,0,-bottom,left]:[a,0,0,-size,left,bottom];
      ops.push(lib.setTextMatrix(...tm),lib.showText(font.encodeText(c.text)));
    }
  }
  ops.push(lib.endText(),lib.popGraphicsState());page.pushOperators(...ops);
}
