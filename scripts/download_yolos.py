import os
import urllib.request
import time

files = [
    "preprocessor_config.json",
    "quantize_config.json",
    "onnx/model_quantized.onnx",
    "onnx/model.onnx",
    "onnx/model_fp16.onnx"
]

base_url = "https://huggingface.co/Xenova/yolos-tiny/resolve/main/"
target_dir = os.path.join("extension", "models", "Xenova", "yolos-tiny")
os.makedirs(os.path.join(target_dir, "onnx"), exist_ok=True)

for rel_path in files:
    url = base_url + rel_path
    dest_path = os.path.join(target_dir, os.path.normpath(rel_path))
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 1000:
        print(f"Skipping already downloaded: {rel_path} ({os.path.getsize(dest_path)} bytes)")
        continue
    print(f"Downloading {rel_path} from {url} ...")
    t0 = time.time()
    opener = urllib.request.build_opener()
    opener.addheaders = [('User-Agent', 'Mozilla/5.0')]
    urllib.request.install_opener(opener)
    urllib.request.urlretrieve(url, dest_path)
    dur = time.time() - t0
    size_mb = os.path.getsize(dest_path) / (1024 * 1024)
    print(f"Downloaded {rel_path}: {size_mb:.2f} MB in {dur:.1f}s")

print("All YOLOS-tiny models downloaded successfully!")

