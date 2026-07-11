"""Generate an image with Azure gpt-image-2. Requires AZ_TOKEN env (cognitiveservices.azure.com scope).
Endpoint from CORDLESS_AZURE_ENDPOINT env or tooling/sol.local.json.
Usage: python gen_logo.py <promptFile> <out.png> [size=1024x1024] [background=opaque|transparent]
"""
import sys, os, json, base64, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

def endpoint():
    ep = os.environ.get("CORDLESS_AZURE_ENDPOINT")
    if not ep:
        with open(os.path.join(HERE, "sol.local.json"), encoding="utf-8") as f:
            ep = json.load(f)["endpoint"]
    return ep.rstrip("/")

tok = os.environ.get("AZ_TOKEN")
if not tok:
    print("Set AZ_TOKEN env (az account get-access-token --resource https://cognitiveservices.azure.com)")
    sys.exit(1)

prompt_file, out = sys.argv[1], sys.argv[2]
size = sys.argv[3] if len(sys.argv) > 3 else "1024x1024"
background = sys.argv[4] if len(sys.argv) > 4 else "opaque"

with open(prompt_file, encoding="utf-8") as f:
    prompt = f.read().strip()

url = f"{endpoint()}/openai/deployments/gpt-image-2/images/generations?api-version=2025-04-01-preview"
body = json.dumps({
    "prompt": prompt,
    "size": size,
    "n": 1,
    "quality": "high",
    "output_format": "png",
    "background": background,
}).encode()

req = urllib.request.Request(
    url, data=body,
    headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:1500])
    sys.exit(2)

b64 = data["data"][0]["b64_json"]
with open(out, "wb") as f:
    f.write(base64.b64decode(b64))
print("saved", out, os.path.getsize(out), "bytes")
