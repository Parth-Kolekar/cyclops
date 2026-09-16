import { env, pipeline, AutoProcessor, AutoModelForObjectDetection } from '@huggingface/transformers';
import { createWorker } from 'tesseract.js';

// Configure transformers.js for browser extension environment
env.allowLocalModels = false;
env.useBrowserCache = true;
// We try to use WebGPU if available, fallback to WASM
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('dist/');

let detectorPipeline = null;
let isInitializing = false;

async function getDetector(forceWasm = false) {
  if (detectorPipeline && !forceWasm) return detectorPipeline;
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
  // Linux Chromium WebGPU currently crashes inside onnxruntime buffer_manager.cc (mapAsync on GPUBuffer).
  // Default to WASM on Linux to avoid GPU crashes; use WebGPU on Windows/macOS with wasm fallback.
  const isLinux = typeof navigator !== 'undefined' && /Linux/i.test(navigator.userAgent);
  const preferredDevice = (!forceWasm && !isLinux) ? 'webgpu' : 'wasm';

  try {
    console.log(`Loading YOLOS detector with device: ${preferredDevice}...`);
    detectorPipeline = await pipeline('object-detection', 'Xenova/yolos-tiny', { device: preferredDevice });
  } catch (err) {
    console.warn(`Failed to load model on ${preferredDevice}, falling back to wasm:`, err);
    try {
      detectorPipeline = await pipeline('object-detection', 'Xenova/yolos-tiny', { device: 'wasm' });
    } catch (e) {
      console.error("Failed to load model on wasm fallback:", e);
      detectorPipeline = null;
    }
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

        const t_start = performance.now();
        // 1. Run object detection inference for visual features
        const personBoxes = [];
        try {
          let detector = await getDetector();
          if (detector) {
            let results;
            try {
              results = await detector(imageUri, { threshold: 0.5 });
            } catch (inferErr) {
              console.warn("Inference failed on current device, retrying with WASM...", inferErr);
              detector = await getDetector(true);
              if (detector) {
                results = await detector(imageUri, { threshold: 0.5 });
              }
            }

            if (Array.isArray(results)) {
              for (const res of results) {
                const { box, label, score } = res;
                if (box && label === 'person' && score > 0.5) {
                  const w = box.xmax - box.xmin;
                  const h = box.ymax - box.ymin;
                  // Guard against corrupt model outputs that cover nearly the entire screen
                  if (w >= canvas.width * 0.85 && h >= canvas.height * 0.85) {
                    console.warn("Ignoring suspiciously large detection box covering whole screen:", box);
                    continue;
                  }
                  personBoxes.push({ x: box.xmin, y: box.ymin, w, h });
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
          ctx.fillRect(b.x, b.y, b.w, b.h);
        }
        
        // 3. Run OCR to detect and redact text PII embedded in images
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
                    
                    ctx.fillStyle = 'black';
                    ctx.fillRect(
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
        
        const t_ocr = performance.now();
        console.table({
          'Yolos Inference': `${(t_yolos - t_start).toFixed(0)} ms`,
          'OCR Redaction': `${(t_ocr - t_yolos).toFixed(0)} ms`,
          'Total Offscreen Vision': `${(t_ocr - t_start).toFixed(0)} ms`
        });
        
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

