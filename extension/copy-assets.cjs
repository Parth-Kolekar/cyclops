const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

function copyFile(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${path.basename(src)} -> dist/`);
  } else {
    console.warn(`Warning: source file not found: ${src}`);
  }
}

// 1. Copy ONNX runtime WASM & MJS binaries
const ortDist = path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist');
if (fs.existsSync(ortDist)) {
  const files = fs.readdirSync(ortDist);
  for (const file of files) {
    if (file.startsWith('ort-wasm') && (file.endsWith('.wasm') || file.endsWith('.mjs'))) {
      fs.copyFileSync(path.join(ortDist, file), path.join(distDir, file));
      console.log(`Copied ${file} -> dist/`);
    }
  }
} else {
  console.warn('Warning: onnxruntime-web dist not found in node_modules');
}

// 2. Copy Tesseract worker & core WASM
copyFile(
  path.join(__dirname, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
  path.join(distDir, 'worker.min.js')
);

copyFile(
  path.join(__dirname, 'node_modules', 'tesseract.js-core', 'tesseract-core.wasm.js'),
  path.join(distDir, 'tesseract-core.wasm.js')
);

// 3. Copy traineddata
const trainedDataPublic = path.join(__dirname, 'public', 'eng.traineddata.gz');
const trainedDataRoot = path.join(__dirname, 'eng.traineddata.gz');
if (fs.existsSync(trainedDataPublic)) {
  copyFile(trainedDataPublic, path.join(distDir, 'eng.traineddata.gz'));
} else if (fs.existsSync(trainedDataRoot)) {
  copyFile(trainedDataRoot, path.join(distDir, 'eng.traineddata.gz'));
} else {
  console.warn('Warning: eng.traineddata.gz not found');
}

