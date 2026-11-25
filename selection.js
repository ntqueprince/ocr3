function enableSymbolSelection(layer, page, words) {
  if(!words.some(word=>word.chars?.length))return;
  layer.classList.add('symbol-selection');
  layer.tabIndex=0;
  const glyphs=words.flatMap((word,wordIndex)=>word.chars.map(box=>({box,wordIndex,row:word.row})));
  const spans=[...layer.querySelectorAll('.ocr-text-span')];
  let anchor=null,selected='',marked=[];
  function caret(event){
    const rect=layer.getBoundingClientRect(),u=(event.clientX-rect.left)/rect.width,v=(event.clientY-rect.top)/rect.height;
    const [a,b]=[[u,v],[v,1-u],[1-u,1-v],[1-v,u]][(page.rotation||0)/90];
    const x=a*page.processedImgWidth,y=b*page.processedImgHeight;
    let score=Infinity,index=0;
    for(let i=0;i<glyphs.length;i++){
      const c=glyphs[i].box,dx=Math.max(c.left-x,x-c.left-c.width,0),dy=Math.max(c.top-y,y-c.top-c.height,0);
      const d=dx*dx+4*dy*dy;
      if(d<score){score=d;index=i}
    }
    const c=glyphs[index].box;
    return {index,edge:index+Number(x>=c.left+c.width/2),distance:Math.sqrt(score)};
  }
  function highlight(start,end){
    for(const span of marked)span.classList.remove('chosen');
    marked=[];selected='';
    let previous=null;
    for(let i=Math.min(start,end);i<Math.max(start,end);i++){
      const ch=glyphs[i];if(previous && previous.wordIndex!==ch.wordIndex)selected+=previous.row===ch.row?' ':'\n';
      selected+=ch.box.text;previous=ch;spans[i].classList.add('chosen');marked.push(spans[i]);
    }
  }
  layer.onpointerdown=e=>{
    if(e.button!==0)return;
    layer.focus({preventScroll:true});getSelection()?.removeAllRanges();const h=caret(e);highlight(0,0);
    if(h.distance>8)return;
    e.preventDefault();anchor=h.edge;layer.setPointerCapture(e.pointerId);
  };
  layer.onpointermove=e=>{if(anchor!==null)highlight(anchor,caret(e).edge)};
  layer.onpointerup=e=>{if(anchor!==null)highlight(anchor,caret(e).edge);anchor=null};
  layer.onpointercancel=()=>{anchor=null};
  layer.ondblclick=e=>{
    const h=caret(e);if(h.distance>8)return;const wi=glyphs[h.index].wordIndex;
    highlight(glyphs.findIndex(c=>c.wordIndex===wi),glyphs.findLastIndex(c=>c.wordIndex===wi)+1);
  };
  layer.oncopy=e=>{if(selected){e.clipboardData.setData('text/plain',selected);e.preventDefault();e.stopPropagation()}};
  layer.onblur=()=>highlight(0,0);
}

