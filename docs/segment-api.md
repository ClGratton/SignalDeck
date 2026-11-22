# Server-side object selection (SAM 2.1 Hiera-Tiny)

Status: deployed and verified 2026-11-22. The client only sends clicks and receives a mask; no model runs in the browser.

## Contract (relay, same auth as the other image-relay routes)

Base: `http://192.168.1.17:18190`. Only source 192.168.1.108 and `Authorization: Bearer <relay token>` are accepted (403 otherwise).

### `POST /segment/embed`
- multipart, one field `image`: PNG or JPEG (magic bytes checked), at most 12 MB, at most 2048 px on the long side, already EXIF-oriented by the client.
- 200 `{"key": "<opaque id>", "width": W, "height": H}`. 400 `invalid image` for bad type, size or a side over 2048. 503 if the segment service is down.
- Computes and caches the image embedding.

### `POST /segment/predict`
- JSON `{"key": "...", "points": [{"x": px, "y": px, "label": 1|0}], "box": [x0,y0,x1,y1] | null}`; coordinates are in the embedded image's pixel space. At least one point or a box; at most 64 points.
- 200 `{"mask": "<base64 PNG, 8-bit single channel, values 0/255, exactly W x H>", "score": float}`.
- 404 `{"error":"unknown key"}` when the embedding expired or was evicted: re-embed and retry. 400 `invalid request`.
- Best of the 3 multimask outputs (highest predicted IoU), then: threshold at 0 on bilinearly upsampled logits, fill holes smaller than 0.2 % of the image (holes touching the border are kept), keep only connected components that contain a positive point (largest component if none does).
- Box is passed as SAM box corner prompts (labels 2/3) and can be combined with points.
- Note: `score` is the model's IoU estimate for the chosen mask. It can read 0.0 when a negative point lies inside the object that the positive point selected (the model is contradicted); the mask is still returned.

## Cache
LRU of 8 embeddings, TTL 30 min (refreshed on each predict). Embedding is about 16 MB each.

## Service (proxmox02)
- Unit `grtlabs-segment.service` (enabled at boot, `Restart=on-failure`), listens on 127.0.0.1:18191 (not reachable from the LAN, only via the relay). Extra route `GET /health`.
- Code `/opt/grtlabs-segment/segment_service.py`; venv `/opt/grtlabs-segment/venv` (local disk; python 3.13, onnxruntime 1.32 CPU, numpy, scipy, pillow, aiohttp); models in `/opt/grtlabs-segment/models`, hashes in `models.sha256`. Total about 480 MB. `selftest.py` is a client test script.
- Model: `Cr7z676/sam2.1-hiera-tiny-onnx` (Apache-2.0), HF revision `f8b86bc94790f7ef78f03a30f73863e741bb6936`:
  - `sam2.1-tiny-encoder.ort` sha256 `6e25853672e5dbaad02ce65ef129ad2e034e211d69d0b6b800dc010dc28b5f27`
  - `sam2.1-tiny-decoder.onnx` sha256 `cf39f03d6093db5ffee1acfc1cf6ab87e177459648e58a21030e256a3e1c7553`
  - Both verified against the hashes published by the HF API. Preprocessing: image squashed (no padding) to 1024x1024, ImageNet mean/std.
- CPU only (onnxruntime, 4 threads, `Nice=10`, memory arena and mem pattern disabled). The P100 is not used, so ComfyUI VRAM is untouched.
- Memory: `MemoryMax=1200M`, `MemorySwapMax=0`. Measured: RSS idle 310 MB, after the first embed about 535-720 MB, peak RSS during an embed about 940 MB (VmHWM), cgroup MemoryPeak about 1.0 GB (includes page cache). A first attempt with `MemoryMax=900M` was OOM-killed by the cgroup during embed (18:56:16 in the journal), so do not lower the cap below about 1100M. Embed is transient: image jobs (about 1.8 GB) need MemAvailable headroom while an embed runs; host MemAvailable stayed 2.9-3.7 GB during tests and there were no other OOM events.
- Relay change: `/mnt/truenas/data/grtlabs-ai/image/relay.py` gained `segment_embed` and `segment_predict` (validation, 35 s / 25 s timeouts, proxy to 127.0.0.1:18191); both routes are listed in the audit categories. Backup: `relay.py.bak-20261122-185901`. Other endpoints unchanged. Relay unit `grtlabs-image-relay` was restarted.

## Measured (test photo, 512x512 and 768x768, from CT108 through the relay)
- Embed: about 3.7-4.5 s warm (target 3 s: missed by about 1 s). Thread count 4/6/8 made no difference; the host is shared (a KVM guest and Jellyfin keep several cores busy). A GPU path would need onnxruntime-gpu plus CUDA libraries (GBs on a root disk with 6 GB free) and would compete with ComfyUI for VRAM, so it was not pursued. The client should show a spinner on the first embed and can embed in the background as soon as the image is loaded.
- Predict: 80-125 ms in all cases (target 300 ms).
- Mask check on an apple photo (Grtlabs_00005_.png, 512x512, apple bbox about [162,320,311,456]):
  - one positive point at (235,385): area 15907 px, bbox [164,320,311,454], score 0.959, covers the whole apple and nothing else.
  - plus a negative point on the table: area 14342, bbox [166,333,311,454], score 0.949 (still the apple).
  - plus a negative point inside the apple: area 15091, score 0.0 (contradictory prompt, see note above).
  - box only: area 15782, bbox [164,325,311,454], score 0.967.
  - unknown key gives 404; non-image body gives 400.

## Operations
- Status: `systemctl status grtlabs-segment`; logs `journalctl -u grtlabs-segment`; `curl 127.0.0.1:18191/health` on proxmox02.
- Restart: `systemctl restart grtlabs-segment` (the cache is lost; clients get 404 and re-embed).
- Self test on proxmox02 (bypasses the relay): `/opt/grtlabs-segment/venv/bin/python /opt/grtlabs-segment/selftest.py http://127.0.0.1:18191 - <image.png>` (coordinates inside are for the apple test image).
- Rollback of the relay: `cp relay.py.bak-20261122-185901 relay.py && systemctl restart grtlabs-image-relay`. Disabling the feature: `systemctl disable --now grtlabs-segment` (relay then answers 503).
- Root disk free after install: 6.2 GB. Keep at least 5 GB free.
- Left to do: none required. Optional: test with a real car photo from the app, and a test from inside the app container itself (the test ran on CT108 itself, same source address 192.168.1.108 that the relay checks; the container-side attempt failed only because of token file permissions in the test harness).
