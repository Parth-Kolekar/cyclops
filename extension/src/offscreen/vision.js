import { env, pipeline, AutoProcessor, AutoModelForObjectDetection } from '@huggingface/transformers';
import { createWorker } from 'tesseract.js';

// Configure transformers.js to load persistent model locally from extension
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.localModelPath = chrome.runtime.getURL('models/');
env.remoteHost = 'https://hf-mirror.com/'; // fast mirror fallback if remote is ever needed
env.useBrowserCache = true;
// We try to use WebGPU if available, fallback to WASM
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('dist/');

// The service worker blocks on our response, so a model that is still
// downloading must not hold the channel open past this.
const DETECTOR_WAIT_MS = 8000;

// YOLOS doesn't have a tokenizer, but transformers.js tries to fetch one anyway.
// On some networks this hangs or throws a blocked fetch error, delaying perception.
// We intercept it and return an immediate 404 to patch the error.
const defaultFetch = fetch;
env.fetch = (url, init) => {
  if (url.includes('tokenizer_config.json') && url.includes('yolos')) {
    return Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
  }
  return defaultFetch(url, init);
};
env.logLevel = 'error'; // Silence non-fatal metadata fetch warnings in console

let detectorPromise = null;

async function loadDetector() {
  // Linux Chromium WebGPU currently crashes inside onnxruntime
  // buffer_manager.cc (mapAsync on GPUBuffer), so it starts on WASM there.
  // Everywhere else WebGPU is tried first and falls back.
  const isLinux = typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent);
  const preferred = isLinux ? 'wasm' : 'webgpu';

  try {
    console.log(`Loading YOLOS detector with device: ${preferred}...`);
    return await pipeline('object-detection', 'Xenova/yolos-tiny', { device: preferred });
  } catch (err) {
    if (preferred === 'wasm') throw err;
    console.warn(`Failed to load model on ${preferred}, falling back to wasm:`, err);
    return await pipeline('object-detection', 'Xenova/yolos-tiny', { device: 'wasm' });
  }
}

/**
 * One promise every caller awaits.
 *
 * The previous version polled a module variable every 100ms and only ever
 * checked for success, so a failed load left every waiter spinning forever —
 * the message channel closed with no response and the screenshot silently
 * vanished from the payload. A failure here resolves to null instead.
 */
function getDetector() {
  if (!detectorPromise) {
    detectorPromise = loadDetector().catch((err) => {
      console.error('Failed to load detector:', err);
      return null;
    });
  }
  return detectorPromise;
}

// Pre-load model in background
getDetector();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REDACT_IMAGE') {
    handleRedact(msg.imageUri, msg.findings, msg.viewport, msg.opaque_regions, msg.elements)
      .then(result => sendResponse({ ok: true, imageUri: result }))
      .catch(err => sendResponse({ ok: false, error: err.toString() }));
    return true; // async response
  }
});

async function handleRedact(imageUri, findings = [], viewport = null, opaque_regions = [], elements = []) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.getElementById('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');

        const t_start = performance.now();
        // 1. Run object detection inference for visual features
        const personBoxes = [];
        try {
          // Cap the wait: a model still downloading must not hold the
          // service worker's message channel open.
          let detector = await Promise.race([
            getDetector(),
            new Promise((r) => setTimeout(() => r(null), DETECTOR_WAIT_MS)),
          ]);
          if (detector) {
            let results;
            try {
              results = await detector(imageUri, { threshold: 0.35 });
            } catch (inferErr) {
              console.warn("Inference failed on current device, retrying with WASM...", inferErr);
              detector = await getDetector();
              if (detector) {
                results = await detector(imageUri, { threshold: 0.35 });
              }
            }

            if (Array.isArray(results)) {
              for (const res of results) {
                const { box, label, score } = res;
                if (box && label === 'person' && score > 0.35) {
                  const w = box.xmax - box.xmin;
                  const h = box.ymax - box.ymin;
                  // Guard against corrupt model outputs that cover nearly the entire screen
                  if (w >= canvas.width * 0.85 && h >= canvas.height * 0.85) {
                    console.warn("Ignoring suspiciously large detection box covering whole screen:", box);
                    continue;
                  }
                  const pad = 4;
                  personBoxes.push({
                    x: Math.max(0, box.xmin - pad),
                    y: Math.max(0, box.ymin - pad),
                    w: Math.min(canvas.width, w + pad * 2),
                    h: Math.min(canvas.height, h + pad * 2)
                  });
                }
              }
            }
          }
        } catch (detectorErr) {
          console.error("YOLOS detection failed:", detectorErr);
        }
        const t_yolos = performance.now();

        // 2. Draw screenshot to canvas.
        // NOTE: Drawn AFTER object detection so that if the GPU process resets during inference,
        // the 2D canvas context is cleanly painted with the image rather than wiped to black.
        ctx.drawImage(img, 0, 0);

        // 3. Redact textual PII from Vault (DOM findings)
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

        // 4. Redact detected persons (faces/bodies)
        for (const b of personBoxes) {
          ctx.fillStyle = '#111111';
          ctx.fillRect(b.x, b.y, b.w, b.h);
          ctx.strokeStyle = '#f43f5e';
          ctx.lineWidth = 2;
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        }
        
        // 5. Run OCR to detect and redact text PII embedded in images (Smart OCR Gating)
        const shouldRunOCR = opaque_regions && opaque_regions.length > 0;
        if (shouldRunOCR) {
          try {
            const worker = await createWorker('eng', 1, {
              workerPath: chrome.runtime.getURL('dist/worker.min.js'),
              corePath: chrome.runtime.getURL('dist/tesseract-core.wasm.js'),
              langPath: chrome.runtime.getURL('dist'),
              workerBlobURL: false
            });
            const { data } = await worker.recognize(canvas, {}, { blocks: true });
            const lines = [];
            if (data.blocks) {
              for (const block of data.blocks) {
                if (!block.paragraphs) continue;
                for (const para of block.paragraphs) {
                  if (!para.lines) continue;
                  for (const line of para.lines) {
                    lines.push(line);
                  }
                }
              }
            }
            const PII_PATTERNS = [
              { label: 'EMAIL',           regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g },
              { label: 'PHONE_IN',        regex: /(\+91[\s-]?)?[6-9]\d{9}/g },
              { label: 'AADHAAR',         regex: /\d{4}\s?\d{4}\s?\d{4}/g },
              { label: 'AADHAAR',         regex: /\d{3,4}\s?\d{4}\s?\d{4}/g },
              { label: 'PAN',             regex: /[A-Z]{5}[0-9]{4}[A-Z]/g },
              { label: 'GST',             regex: /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/g },
              { label: 'CREDIT_CARD',     regex: /\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g },
              { label: 'CREDIT_CARD',     regex: /\d{3,4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}/g },
              { label: 'IFSC',            regex: /[A-Z]{4}0[A-Z0-9]{6}/g },
              { label: 'PASSPORT_IN',     regex: /[A-Z][1-9]\d{7}/g }
            ];

            for (const line of lines) {
              for (const pattern of PII_PATTERNS) {
                const regex = new RegExp(pattern.regex.source, 'g');
                let match;
                while ((match = regex.exec(line.text)) !== null) {
                  const matchStart = match.index;
                  const matchEnd = match.index + match[0].length;
                  
                  let charIndex = 0;
                  for (const word of line.words || []) {
                    const wordStart = line.text.indexOf(word.text, charIndex);
                    if (wordStart === -1) continue;
                    const wordEnd = wordStart + word.text.length;
                    charIndex = wordEnd;
                    
                    if (wordEnd > matchStart && wordStart < matchEnd) {
                      const bbox = word.bbox;
                      const h = bbox.y1 - bbox.y0;
                      const w = bbox.x1 - bbox.x0;
                      // OCR boxes are often very tight baselines. Dilate to cover the full text.
                      const padYTop = h * 1.5;
                      const padYBot = h * 0.5;
                      const padX = h * 0.3;
                      
                      ctx.fillStyle = '#111111';
                      ctx.fillRect(
                        bbox.x0 - padX, 
                        bbox.y0 - padYTop, 
                        w + (padX * 2), 
                        h + padYTop + padYBot
                      );
                      ctx.strokeStyle = '#f43f5e';
                      ctx.lineWidth = 1;
                      ctx.strokeRect(
                        bbox.x0 - padX, 
                        bbox.y0 - padYTop, 
                        w + (padX * 2), 
                        h + padYTop + padYBot
                      );
                    }
                  }
                }
              }
            }
            await worker.terminate();
          } catch (err) {
            console.error("OCR redaction failed:", err);
          }
        }
        
        const t_ocr = performance.now();
        console.table({
          'Yolos Inference': `${(t_yolos - t_start).toFixed(0)} ms`,
          'OCR Redaction': shouldRunOCR ? `${(t_ocr - t_yolos).toFixed(0)} ms` : 'Skipped (0 ms)',
          'Total Offscreen Vision': `${(t_ocr - t_start).toFixed(0)} ms`
        });
        
        // 6. Draw interactive element overlays (crisp red bounding boxes + e-id tags) AFTER masking!
        if (elements && viewport) {
          const scaleX = img.width / viewport.w;
          const scaleY = img.height / viewport.h;
          const normScale = viewport.norm_scale || 1000;

          for (const el of elements) {
            if (!el.bbox) continue;
            const [nx, ny, nw, nh] = el.bbox;
            const cssX = nx / normScale;
            const cssY = ny / normScale;
            const cssW = nw / normScale;
            const cssH = nh / normScale;

            const x = cssX * scaleX;
            const y = cssY * scaleY;
            const w = cssW * scaleX;
            const h = cssH * scaleY;

            // Draw crisp red bounding box
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x, y, w, h);

            // Draw tag badge on top of element
            const tag = el.id;
            ctx.font = 'bold 11px ui-monospace, monospace';
            const textWidth = ctx.measureText(tag).width;
            const tagH = 13;
            const tagW = textWidth + 6;
            const tagY = y >= tagH ? y - tagH : y;

            ctx.fillStyle = '#f43f5e';
            ctx.fillRect(x, tagY, tagW, tagH);

            ctx.fillStyle = '#ffffff';
            ctx.fillText(tag, x + 3, tagY + 10);
          }
        }

        // Return redacted image with crisp overlays
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = imageUri;
  });
}



/* 
 * TODO(Engineer 5): Smart OCR Gating
 * Only invoke Tesseract if (payload.opaque_regions && payload.opaque_regions.length > 0).
 * Otherwise, return early to save CPU.
 */
