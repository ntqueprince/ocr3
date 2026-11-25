/* Local engines are loaded on first selection. Each returns rows of words in original image coordinates. */
const engineAssets = {
  plus: ['plus-data','tesseract.min','plus'],
  precise: ['ocr-core','ocr-worker','ocr-eng','precise']
};
const scriptLoads = new Map();
function localScript(name) {
  if (!scriptLoads.has(name)) {
    const script = document.createElement('script');
    script.src = './' + name + '.js';
    scriptLoads.set(name, new Promise((resolve,reject) => {
      script.onload = resolve;
      script.onerror = () => { scriptLoads.delete(name); script.remove(); reject(new Error('Could not load the bundled OCR files.')); };
      document.head.append(script);
    }));
  }
  return scriptLoads.get(name);
}
async function localScan(id,file) {
  for (const asset of engineAssets[id]) await localScript(asset);
  const image = await getImage(file);
  const lines = await (id === 'plus' ? window.plusScan : window.preciseScan)(image);
  return {width:image.naturalWidth,height:image.naturalHeight,
    words:lines.flatMap((line,row) => line.map(word => ({...word,row})))};
}

