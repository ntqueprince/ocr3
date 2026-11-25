const {PDFDocument}=window.PDFLib;
const $ = (id) => document.getElementById(id);
const state = { pages: [], pdfUrl: null, page: 1, zoom: 1, rotation: 0, busy: false, ocr: { queue: [], running: false, hidden: false } };
const supportedImage = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(f.name);
const OCR_SPACE_KEY = "K8107911562773188957";
const ocrResultCache = new Map();


function updateOcrStatus(page, message, count = null) {
  const el = page?.overlayStatus;
  if (el) el.textContent = count === null ? message : `${message} · ${count} word${count === 1 ? "" : "s"}`;
}
function makeOcrOverlay(page, image) {
  const container = document.createElement("div"); container.className = "ocr-image-wrap";
  const layer = document.createElement("div"); layer.className = "ocr-text-layer"; layer.setAttribute("aria-label", "Detected selectable text");
  container.append(image, layer); page.overlay = layer; page.overlayWrap = container;
  const sync = () => {
    const rect = {width:image.clientWidth,height:image.clientHeight};
    if (!rect.width || !rect.height || !image.naturalWidth) return;
    const sx = rect.width / (page.processedImgWidth || image.naturalWidth), sy = rect.height / (page.processedImgHeight || image.naturalHeight);
    layer.style.transform=image.style.transform;layer.style.transformOrigin="center";
    layer.style.width = `${rect.width}px`; layer.style.height = `${rect.height}px`;
    for (const span of layer.querySelectorAll(".ocr-text-span")) {
      const b = span._box, top = b.top * sy, left = b.left * sx, height = b.height * sy, targetWidth = b.width * sx;
      span.style.top = `${top}px`; span.style.left = `${left}px`; span.style.height = `${Math.max(1, height)}px`; span.style.fontSize = `${Math.max(8, height * .92)}px`;
      const natural = Math.max(1, measureTextWidth(span.textContent, span.style.fontSize)); span.style.transform = `scaleX(${targetWidth / natural})`;
    }
  };
  page.syncOverlay = sync; image.addEventListener("load", sync); page.overlayObserver = new ResizeObserver(sync); page.overlayObserver.observe(image); 
  return container;
}
const measureCanvas = document.createElement("canvas");
const measureContext = measureCanvas.getContext("2d");
function measureTextWidth(text, fontSize) { measureContext.font = `${fontSize} Arial`; return measureContext.measureText(text).width; }
function sortOcrItems(items) { return items.sort((a, b) => Math.abs(a.top - b.top) <= 8 ? a.left - b.left : a.top - b.top); }
function renderOcrItems(page, items) {
  page.overlay.replaceChildren();
  let previous=null;
  for(const item of items){
    if(previous)page.overlay.append(document.createTextNode(previous.row===item.row?' ':'\n'));
    const word=document.createElement('span');word.className='ocr-word';
    for(const box of item.chars?.length?item.chars:[item]){
      const span=document.createElement('span');span.className='ocr-text-span ocr-box';span.textContent=box.text;span._box=box;word.append(span);
    }
    word.ondblclick=event=>{event.preventDefault();const range=document.createRange();range.selectNodeContents(word);const sel=getSelection();sel.removeAllRanges();sel.addRange(range)};
    page.overlay.append(word);previous=item;
  }
  enableSymbolSelection(page.overlay,page,items);
  page.ocrItems = items; page.ocrStatusText = `Text ready to copy · ${items.length} words`; requestAnimationFrame(() => page.syncOverlay?.()); updateOcrStatus(page, "Text ready to copy", items.length);
}
document.addEventListener('copy',event=>{
  const selection=getSelection();if(!selection?.rangeCount || selection.isCollapsed)return;
  const range=selection.getRangeAt(0);
  const layer=selection.anchorNode?.parentElement?.closest('.ocr-text-layer');
  if(!layer || !layer.contains(selection.focusNode))return;
  event.clipboardData.setData('text/plain',range.cloneContents().textContent);event.preventDefault();
});
async function makeOcrImage(page) {
  const image = await getImage(page.file);
  const scale = Math.min(1, 1100 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d"); if (!context) throw new Error("Could not prepare the image for OCR.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not encode image for OCR.")), "image/jpeg", .8));
  page.processedImgWidth = canvas.width; page.processedImgHeight = canvas.height; return blob;
}
let engineRevision=0;
let cloudController=null;
async function scanPage(page,id,revision) {
  const key=id+'|'+await getImageFingerprint(page.file);
  const current=()=>revision===engineRevision && state.pages.includes(page);
  if(!current())return;
  let result=ocrResultCache.get(key);
  if(!result){
    updateOcrStatus(page,'Reading with '+$('engineChoice').selectedOptions[0].textContent+'…');
    result=id==='space'?await runOcrSpaceScan({...page},current):await localScan(id,page.file);
    if(state.pages.includes(page))ocrResultCache.set(key,result);
  }
  if(!current())return;
  page.processedImgWidth=result.width;page.processedImgHeight=result.height;
  page.ocrDone=true;renderOcrItems(page,result.words);
}
async function runOcrSpaceScan(page,current) {
  updateOcrStatus(page, "Scanning text…");
  const imageBlob = await makeOcrImage(page), form = new FormData();
  if(!current())throw new Error("Engine changed");
  form.append("apikey", OCR_SPACE_KEY); form.append("language", "eng"); form.append("isOverlayRequired", "true"); form.append("OCREngine", "2"); form.append("file", imageBlob, "scan.jpg");
  const controller=new AbortController();
  cloudController=controller;
  const timeout=setTimeout(()=>controller.abort(),45000);
  let response,data;
  try {
    response=await fetch("https://api.ocr.space/parse/image",{method:"POST",body:form,signal:controller.signal});
    data=await response.json();
  } finally {clearTimeout(timeout);if(cloudController===controller)cloudController=null}
  if (!response.ok || data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.join(" ") || `OCR.space returned ${response.status}.`);
  const lines = data.ParsedResults?.[0]?.TextOverlay?.Lines || [];
  const words = lines.flatMap((line,row) => (line.Words || []).map(word => ({ text: word.WordText, row, left: Number(word.Left), top: Number(word.Top), width: Number(word.Width), height: Number(word.Height) })))
    .filter(word => word.text && [word.left, word.top, word.width, word.height].every(Number.isFinite));
  return { words: words, width: page.processedImgWidth, height: page.processedImgHeight };
}
async function getImageFingerprint(file) {
  const bytes = await file.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  const view = new Uint8Array(bytes);
  for (const byte of view) hash = Math.imul(hash ^ byte, 16777619);
  return `${file.size}:${file.type}:${hash >>> 0}`;
}
function enqueueScan(page) {
  if(page.ocrDone || page.ocrQueued)return;
  page.ocrQueued=true;
  state.ocr.queue.push({page,id:$('engineChoice').value,revision:engineRevision});
  updateOcrStatus(page,'Waiting to scan…');processOcrQueue();
}
async function processOcrQueue(){
  if(state.ocr.running)return;
  state.ocr.running=true;
  try{
    while(state.ocr.queue.length){
      const {page,id,revision}=state.ocr.queue.shift();
      try{await scanPage(page,id,revision)}
      catch(err){if(revision===engineRevision && state.pages.includes(page)){
        page.ocrStatusText='Scan failed · '+(err.message||err);updateOcrStatus(page,page.ocrStatusText);
      }}
      finally{if(revision===engineRevision)page.ocrQueued=false}
    }
  }finally{state.ocr.running=false}
}
$('engineChoice').onchange=()=>{
  if(state.busy){toast('Wait until processing finishes before changing the OCR engine.');$('engineChoice').value=state.activeEngine||'plus';return;}
  state.activeEngine=$('engineChoice').value;
  cloudController?.abort();engineRevision++;state.ocr.queue.length=0;
  $('engineInfo').textContent=$('engineChoice').value==='space'?'Images are sent to OCR.Space.':'Images are read on this device.';
  for(const page of state.pages){page.ocrDone=false;page.ocrQueued=false;page.ocrItems=null;page.ocrStatusText='';}
  renderQueue();
};
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 4500);
}
function status(message) { $("status").textContent = message; }
function progress(value, message) {
  $("progressWrap").classList.remove("hidden");
  $("progressBar").style.width = `${Math.max(0, Math.min(100, value))}%`;
  $("progressText").textContent = message;
}
function hideProgress() { $("progressWrap").classList.add("hidden"); }
function showWorkspace() {
  $("welcome").classList.add("hidden"); $("workspace").classList.remove("hidden");
  $("uploadMore").classList.remove("hidden");
}
function updatePageLabel() {
  $("pageLabel").textContent = `${state.pages.length} ${state.pages.length === 1 ? "image" : "images"}`;
}
function renderQueue() {
  for(const page of state.pages)page.overlayObserver?.disconnect();
  const list = $("pageGallery");
  if (!list) return;
  list.replaceChildren();
  for (let i = 0; i < state.pages.length; i++) {
    const p = state.pages[i], row = document.createElement("article"), image = document.createElement("img"), details = document.createElement("div"), name = document.createElement("strong"), dimensions = document.createElement("span"), actions = document.createElement("div");
    row.className = "preview-page-row";
    image.className = "preview-page-image"; image.src = p.previewUrl; image.alt = p.name; image.loading = "lazy";
    image.style.transform = `rotate(${p.rotation || 0}deg)`;
    details.className = "preview-page-details";
    name.textContent = `${i + 1}. ${p.name}`;
    const swapped = (p.rotation || 0) % 180 !== 0;
    dimensions.textContent = `${(swapped ? p.height : p.width).toLocaleString()} × ${(swapped ? p.width : p.height).toLocaleString()} px`;
    const statusEl = document.createElement("span"); statusEl.className = "ocr-status"; statusEl.textContent = p.ocrStatusText || (p.ocrDone ? `Text ready to copy · ${p.ocrItems?.length || 0} words` : p.ocrQueued ? "Scanning text…" : "Text scan pending"); p.overlayStatus = statusEl;
    details.append(name, dimensions, statusEl);
    actions.className = "preview-page-actions";
    for (const direction of [{ angle: -90, label: "Rotate left" }, { angle: 90, label: "Rotate right" }]) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "tool"; button.textContent = direction.angle < 0 ? "↶" : "↷";
      button.title = `${direction.label}: ${p.name}`; button.setAttribute("aria-label", button.title);
      button.addEventListener("click", () => rotateImage(i, direction.angle));
      actions.append(button);
    }
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "tool image-delete"; remove.textContent = "×";
    remove.title = `Delete ${p.name}`; remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => removeImage(i)); actions.append(remove);
    const imageWrap = makeOcrOverlay(p, image);
    if (p.ocrItems) renderOcrItems(p, p.ocrItems);
    const overlayToggle = document.createElement("button"); overlayToggle.type = "button"; overlayToggle.className = "tool overlay-toggle"; overlayToggle.textContent = "Show Text Boxes";
    overlayToggle.addEventListener("click", () => { const enabled = !p.overlay.classList.contains("show-boxes"); p.overlay.classList.toggle("show-boxes", enabled); overlayToggle.textContent = enabled ? "Hide Text Boxes" : "Show Text Boxes"; });
    const visual = document.createElement("div"); visual.className = "preview-visual"; visual.append(imageWrap, overlayToggle);
    row.append(visual, details, actions); list.append(row);
    if (!p.ocrDone && !p.ocrQueued && !state.ocr.queue.includes(p)) enqueueScan(p);
  }
  $("downloadPdf").disabled = !state.pdfUrl || state.busy;
  updatePageLabel();
}
async function downloadCurrentPdf() {
  if (state.busy || !state.pages.length) return;
  const revision=engineRevision;
  state.busy=true; renderQueue();
  try {
    status("Waiting for OCR before searchable export…");
    while(state.ocr.running || state.ocr.queue.length) await new Promise(resolve=>setTimeout(resolve,100));
    if(revision!==engineRevision)throw Error("OCR engine changed. Download again after scanning finishes.");
    const failed=state.pages.filter(p=>!p.ocrDone);
    if(failed.length)throw Error("OCR failed on "+failed.length+" page(s). Retry the local engine before downloading.");
    const bytes=await buildPdf(state.pages);
    if(state.pdfUrl)URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));
    status("Searchable PDF ready");
  } catch(error) {toast(error.message||String(error));status("Searchable export failed");return;}
  finally {state.busy=false;renderQueue();hideProgress();}
  if (!state.pdfUrl || state.busy) return;
  const link = document.createElement("a");
  link.href = state.pdfUrl;
  link.download = `photos-${state.pages.length}-pages.pdf`;
  document.body.append(link); link.click(); link.remove();
}
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file);
  });
}
function getImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} is not a readable image`)); };
    img.src = url;
  });
}
async function imageFileToPage(file) {
  const mime = file.type.toLowerCase();
  // JPEG and PNG can be embedded directly from their original bytes. Other formats
  // are losslessly converted to PNG at their original pixel dimensions.
  if (mime === "image/png" || (mime === "image/jpeg" && !hasExifRotation(await file.arrayBuffer()))) {
    const img = await getImage(file);
    return { file, bytes: await file.arrayBuffer(), mime, width: img.naturalWidth, height: img.naturalHeight, name: file.name, previewUrl: URL.createObjectURL(file) };
  }
  const img = await getImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Could not prepare the image for PDF.");
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error(`Could not convert ${file.name}`)), "image/png"));
  return { file: blob, bytes: await blob.arrayBuffer(), mime: "image/png", width: canvas.width, height: canvas.height, name: file.name, previewUrl: URL.createObjectURL(blob) };
}
async function buildPdf(pages) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if(p.pdfSource){
      const [page]=await pdf.copyPages(p.pdfSource,[p.pdfIndex]);pdf.addPage(page);
      page.setRotation(window.PDFLib.degrees((page.getRotation().angle+(p.rotation||0))%360));
      const t=p.pdfViewport.transform,det=t[0]*t[3]-t[1]*t[2];
      const inverse=[t[3]/det,-t[1]/det,-t[2]/det,t[0]/det,
        (t[2]*t[5]-t[3]*t[4])/det,(t[1]*t[4]-t[0]*t[5])/det];
      await addSearchableLayer(pdf,page,p,inverse);
      continue;
    }
    const pointsPerPixel = 72 / 150;
    const rotated = (p.rotation || 0) % 180 !== 0;
    const pageWidth = (rotated ? p.height : p.width) * pointsPerPixel;
    const pageHeight = (rotated ? p.width : p.height) * pointsPerPixel;
    const page = pdf.addPage([pageWidth, pageHeight]);
    const rotation = -(p.rotation || 0) * Math.PI / 180;
    const image = p.mime === "image/jpeg" ? await pdf.embedJpg(p.bytes) : await pdf.embedPng(p.bytes);
    const imageWidth = p.width * pointsPerPixel, imageHeight = p.height * pointsPerPixel;
    const originX = pageWidth / 2 - (imageWidth * Math.cos(rotation) - imageHeight * Math.sin(rotation)) / 2;
    const originY = pageHeight / 2 - (imageWidth * Math.sin(rotation) + imageHeight * Math.cos(rotation)) / 2;
    page.drawImage(image, {
      x: originX, y: originY,
      width: p.width * pointsPerPixel, height: p.height * pointsPerPixel,
      rotate: { type: "degrees", angle: -(p.rotation || 0) },
    });
    const sx=imageWidth/(p.processedImgWidth||p.width), sy=imageHeight/(p.processedImgHeight||p.height);
    await addSearchableLayer(pdf,page,p,[sx*Math.cos(rotation),sx*Math.sin(rotation),sy*Math.sin(rotation),-sy*Math.cos(rotation),originX-imageHeight*Math.sin(rotation),originY+imageHeight*Math.cos(rotation)]);
    progress(80 + (i + 1) / pages.length * 18, `Building PDF… ${i + 1}/${pages.length}`);
  }
  return pdf.save({ useObjectStreams: true });
}
async function rotateImage(index, angle = 90) {
  const page = state.pages[index];
  if (!page || state.busy) return;
  page.rotation = ((page.rotation || 0) + angle + 360) % 360;
  state.page = index + 1; updatePageLabel();
  renderQueue(); state.busy = true; renderQueue();
  status(`Rotating ${page.name}…`); progress(0, "Updating PDF…");
  try {
    const bytes = await buildPdf(state.pages);
    const newUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const oldUrl = state.pdfUrl; state.pdfUrl = newUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    status(`${state.pages.length} page(s) ready`); progress(100, "Rotation updated");
  } catch (err) {
    page.rotation = (page.rotation - angle + 360) % 360;
    console.error(err); toast(`Could not rotate image: ${err.message || err}`); status("PDF update failed");
  } finally { state.busy = false; renderQueue(); setTimeout(hideProgress, 800); }
}
async function removeImage(index) {
  if (state.busy) { toast("Wait until the PDF update finishes."); return; }
  const [removed] = state.pages.splice(index, 1);
  removed?.overlayObserver?.disconnect();
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  if (!state.pages.length) {
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = null; state.page = 1; updatePageLabel(); renderQueue();
    $("workspace").classList.add("hidden"); $("welcome").classList.remove("hidden"); $("uploadMore").classList.add("hidden");
    return;
  }
  state.page = Math.min(state.page, state.pages.length); renderQueue(); state.busy = true; renderQueue();
  status("Updating PDF after deleting image…"); progress(0, "Updating PDF…");
  try {
    const bytes = await buildPdf(state.pages), newUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })), oldUrl = state.pdfUrl;
    state.pdfUrl = newUrl; if (oldUrl) URL.revokeObjectURL(oldUrl);
    status(`${state.pages.length} page(s) ready`); progress(100, "PDF updated");
  } catch (err) { console.error(err); toast(`Could not update PDF: ${err.message || err}`); }
  finally { state.busy = false; renderQueue(); setTimeout(hideProgress, 800); }
}
async function processFiles(fileList) {
  if (state.busy) { toast("Please wait until the current files finish processing."); return; }
  const supported=f=>supportedImage(f)||f.type==="application/pdf"||/\.pdf$/i.test(f.name);
  const files = [...fileList].filter(supported);
  if (!files.length) { toast("Choose images or a PDF to create a searchable PDF."); return; }
  const invalid = [...fileList].filter(f => !supported(f));
  if (invalid.length) toast(`Skipped unsupported file(s): ${invalid.map(f => f.name).join(", ")}`);
  state.busy = true; showWorkspace(); $("emptyPreview").classList.remove("hidden");
  progress(0, "Preparing images…"); status("Preparing images…");
  try {
    const incoming = [];
    for (let i = 0; i < files.length; i++) {
      status(`Opening ${files[i].name}…`);
      if(supportedImage(files[i])) incoming.push(await imageFileToPage(files[i]));
      else incoming.push(...await openPdfRasterPages(files[i]));
      progress((i + 1) / files.length * 70, `Preparing images… ${i + 1}/${files.length}`);
    }
    const priorCount = state.pages.length;
    state.pages.push(...incoming);
    state.page = priorCount + 1;
    renderQueue();
    status("Creating your PDF…");
    const bytes = await buildPdf(state.pages);
    const newUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
    state.pdfUrl = newUrl;
    $("emptyPreview").classList.add("hidden");
    state.zoom = 1; updatePageLabel();
    status(`${state.pages.length} page(s) ready`); progress(100, "PDF ready"); renderQueue();
    setTimeout(hideProgress, 800);
  } catch (err) {
    console.error(err); status("Could not create PDF"); toast(err.message || "Could not create the PDF."); hideProgress();
  } finally { state.busy = false; $("fileInput").value = ""; renderQueue(); }
}
$("downloadPdf").addEventListener("click", () => {
  void downloadCurrentPdf();
});
async function pasteClipboard() {
  try {
    if (!navigator.clipboard?.read) throw new Error("Clipboard image access is not available");
    const items = await navigator.clipboard.read(), files = [];
    for (const item of items) {
      for (const type of item.types.filter(t => t.startsWith("image/"))) {
        const ext = type.split("/")[1].replace("jpeg", "jpg");
        files.push(new File([await item.getType(type)], `pasted-image-${Date.now()}-${files.length + 1}.${ext}`, { type }));
      }
    }
    if (files.length) await processFiles(files);
    else toast("No image found in the clipboard. Copy an image first, then try Paste.");
  } catch { toast("Clipboard access was unavailable. Click this page and press Ctrl+V, or use Upload images."); }
}
document.addEventListener("paste", e => {
  const files = [...(e.clipboardData?.items || [])]
    .filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); processFiles(files); }
});
$("pasteButton").addEventListener("click", pasteClipboard);
$("fileInput").addEventListener("change", e => processFiles(e.target.files));
$("uploadMore").addEventListener("click", () => $("fileInput").click());
$("dropzone").addEventListener("dragover", e => { e.preventDefault(); $("dropzone").classList.add("dragover"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("dragover"));
$("dropzone").addEventListener("drop", e => { e.preventDefault(); $("dropzone").classList.remove("dragover"); processFiles(e.dataTransfer.files); });
$("fullscreen").addEventListener("click", () => { const el = $("previewFrame"); if (!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.(); });
$("remove").addEventListener("click", () => {
  if (state.busy) { toast("Wait until processing finishes before clearing the PDF."); return; }
  state.pages.forEach(p => URL.revokeObjectURL(p.previewUrl));
  state.pages.forEach(p=>p.overlayObserver?.disconnect());ocrResultCache.clear();cloudController?.abort();engineRevision++;state.ocr.queue.length=0;
  state.pages = []; if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl); state.pdfUrl = null;
  $("workspace").classList.add("hidden"); $("welcome").classList.remove("hidden");
  $("uploadMore").classList.add("hidden"); hideProgress(); status("Ready"); state.page = 1; state.zoom = 1; updatePageLabel();
  renderQueue();
});
window.addEventListener("beforeunload", () => { if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl); state.pages.forEach(page => page.overlayObserver?.disconnect()); });
