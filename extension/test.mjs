import { pipeline, env } from '@huggingface/transformers';
env.allowLocalModels = false;
async function test() {
  console.log("Loading model...");
  try {
    const detector = await pipeline('object-detection', 'Xenova/detr-resnet-50', { device: 'wasm' });
    console.log("Model loaded successfully!");
  } catch(e) {
    console.error("Error:", e);
  }
}
test();
