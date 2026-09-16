import json

with open("extension/manifest.json", "r") as f:
    data = json.load(f)

if "web_accessible_resources" not in data:
    data["web_accessible_resources"] = [{
        "resources": ["src/content/tools/*.js"],
        "matches": ["<all_urls>"]
    }]

with open("extension/manifest.json", "w") as f:
    json.dump(data, f, indent=2)
