import { env, pipeline, AutoProcessor, AutoModelForObjectDetection } from '@huggingface/transformers';

// Configure transformers.js for browser extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;
// We try to use WebGPU if available, fallback to WASM
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('dist/');

let detectorPipeline = null;
let isInitializing = false;

async function getDetector() {
  if (detectorPipeline) return detectorPipeline;
  if (isInitializing) {
    // Wait until initialized
    return new Promise(resolve => {
      const check = setInterval(() => {
        if (detectorPipeline) {
          clearInterval(check);
          resolve(detectorPipeline);
        }
      }, 100);
    });
  }
  
  isInitializing = true;
  try {
    // Let Transformers.js automatically select WebGPU, falling back to CPU (WASM) if not available
    detectorPipeline = await pipeline('object-detection', 'Xenova/detr-resnet-50');
  } catch (err) {
    console.error("Failed to load model:", err);
  }
  isInitializing = false;
  return detectorPipeline;
}

// Pre-load model in background
getDetector().catch(console.error);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REDACT_IMAGE') {
    handleRedact(msg.imageUri, msg.findings, msg.viewport)
      .then(result => sendResponse({ ok: true, imageUri: result }))
      .catch(err => sendResponse({ ok: false, error: err.toString() }));
    return true; // async response
  }
});

async function handleRedact(imageUri, findings = [], viewport = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.getElementById('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // 1. Redact textual PII from Vault
        ctx.fillStyle = 'black';
        if (viewport && findings && findings.length > 0) {
          const scaleX = img.width / viewport.w;
          const scaleY = img.height / viewport.h;
          for (const f of findings) {
            if (!f.bbox) continue;
            // bbox is [x, y, w, h] normalized by norm_scale
            const [nx, ny, nw, nh] = f.bbox;
            const origX = nx / viewport.norm_scale;
            const origY = ny / viewport.norm_scale;
            const origW = nw / viewport.norm_scale;
            const origH = nh / viewport.norm_scale;
            
            ctx.fillRect(
              origX * scaleX, 
              origY * scaleY, 
              origW * scaleX, 
              origH * scaleY
            );
          }
        }

        // 2. Run object detection inference for visual features
        const detector = await getDetector();
        if (detector) {
          const results = await detector(imageUri, { threshold: 0.5 });
          
          for (const res of results) {
            const { box, label, score } = res;
            // Redact detected persons (faces/bodies)
            if (box && label === 'person' && score > 0.5) {
              ctx.fillRect(box.xmin, box.ymin, box.xmax - box.xmin, box.ymax - box.ymin);
            }
          }
        }
        
        // Return redacted image
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = imageUri;
  });
}

