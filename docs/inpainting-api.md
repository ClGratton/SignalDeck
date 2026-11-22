# SignalDeck inpainting: relay API contract for the UI / app route

Date: 2026-11-22. Server side is implemented and tested on proxmox02 (relay `192.168.1.17:18190`, accepts only 192.168.1.108 with the bearer token, same as the other endpoints). Design basis: `docs/inpainting-research.md`. App code is NOT changed yet; this document is what `app/api/assistant/images/route.ts` must implement.

## 1. Flow (two relay calls, then the usual polling)

1. `POST {COMFYUI_URL}/upload/inpaint` (multipart, `Authorization: Bearer <token>`)
   - parts, in this exact order: `image` then `mask` (exactly these two, nothing else)
   - `image`: PNG, JPEG or WEBP, at most 12 MB. EXIF orientation is applied by the server, so send the image the user SEES; the mask must match that oriented size.
   - `mask`: PNG, at most 4 MB, same width/height as the (oriented) image. Modes accepted: 1-bit, L, RGB, RGBA (RGBA only if alpha is fully 255). White (255) = region to change, black (0) = keep. **Hard binary only: every pixel exactly 0 or 255** (no anti-aliasing, no gray). Export from the canvas with smoothing off/threshold at 128. At least one white pixel.
   - Image limits: each side 64..3072 px, area at most 9.5 Mpx. Recommend the UI caps the long side at 2048 (the mask canvas cap in the design) and always sends PNG.
   - Response 200: `{"image":"<32hex>.png","mask":"<32hex>-mask.png","width":W,"height":H}`. Any violation: `400 invalid image or mask` (deliberately generic).
   - Server stores the re-encoded lossless PNGs (RGB image, L mask) in the relay upload dir. Names are single-use handles for the next call (the same handles can be reused for several jobs, e.g. strength retries).
2. `POST {COMFYUI_URL}/prompt` with body `{"prompt": <graph>}` exactly as for img2img. The graph is `workflows/lustify-inpaint-template.json` with the placeholders below substituted. The relay accepts the graph only if, after normalising the substituted fields, it equals the template node for node (same strictness as txt2img/img2img). So the app must send the template unchanged except for these fields:

| Placeholder | Node / field | Type, range (relay-enforced) |
|---|---|---|
| `{{PROMPT}}` | 3 `text` | string 1..4000 chars |
| `{{SEED}}` | 7 `seed` | int 0..2^64-1 (replace the quoted token with a bare number) |
| `{{IMAGE}}` | 10 `image` | `image` handle from step 1 |
| `{{MASK}}` | 11 `image` | `mask` handle from step 1 (must share the 32-hex id with the image) |
| `{{STRENGTH}}` | 7 `denoise` | number 0.05..1.0 (bare number) |
| `{{GROW}}` | 12 `mask_expand_pixels` | int 0..64 (bare number) |
| `{{BLEND}}` | 12 `mask_blend_pixels` | int 0..128 (bare number) |
| `{{CONTEXT}}` | 12 `context_from_mask_extend_factor` | number 1.0..3.0 (bare number) |

   Replace the quoted token including its quotes for numeric fields (`"{{STRENGTH}}"` becomes `0.55`). Everything else (steps 8, cfg 1, euler/simple, crop target 1024, padding 32, hipass 0.1, fill holes, GPU mode) is fixed in the template and must not be altered, or `/prompt` answers `400 invalid graph`.
   - Response `{"prompt_id": "<uuid>"}`. Errors: `409` queue full (retry later), `503` storage busy or GPU recovery in progress (retry), `400` invalid graph or unknown handle.
3. Poll `GET /history/{prompt_id}` (empty `{}` while pending/running; then `status.status_str` success/error) and fetch the result with `GET /view?type=output&filename=<name>` exactly as today. The output is the full-resolution stitched PNG (same size as the uploaded image). Outside the selection the output is restored bit-exact from the source by `composite_guard.py` beyond the effective blend band. Measured on job 357979bd (car, grow 8, blend 28, 2016x1134): changed pixels only within the legit band (max 126 px from the mask; 0 changed pixels beyond it; max abs diff 169 in the 1-110 px band, 21 in the 110-126 px tail); border bands from InpaintCropImproved's beyond-image padding eliminated (rows 0-20 and cols 0-30: 0 changed pixels). Inside the mask L*a*b* 78.2/0.6/1.2 (white car). Band reason: the guard works at full output resolution, not at the 1024 crop size: it dilates the mask by grow+blend (36 px, square kernel) and blurs with sigma 0.5*blend*sqrt(2)*1.3 = 25.7 px, keeping pixels with weight > 0.002, which extends the band to about 110-126 px. The result can be re-uploaded as the next source for chained edits.

Existing endpoints (`/upload/image`, `/prompt` for txt2img/img2img, `/history`, `/view`, `/object_info/UnetLoaderGGUF`) are unchanged. Note: `/upload/image` had a latent bug (a function named `io` shadowed the `io` module, so every call returned 400); it is fixed in the same change.

## 2. Parameters by mode (what the route sends)

Common: crop 1024 and padding 32 are fixed in the template. Blend 24-32, hipass 0.1, fill holes on.

| UI mode | STRENGTH | GROW | BLEND | CONTEXT | PROMPT |
|---|---|---|---|---|---|
| Recolor / material change | 0.45-0.65 (default 0.55) | 8 | 28 | 1.5 | describe the target, e.g. "red leather, same lighting" |
| Replace object | 0.80-0.90 (default 0.85) | 8 | 28 | 1.5 | what should appear |
| Remove object | 1.0 | 10 | 28 | 2.0 | neutral, e.g. "empty plain background, natural texture continuing the surroundings" |

UI knobs: Strength slider maps to STRENGTH (clamp 0.05..1), Grow slider 0..64 maps to GROW, "Feather/Blend" 0..128 maps to BLEND. Seed: random per job, shown to allow repeat.

## 3. Timing and operational facts the UI must respect

- One image job at a time (shared P100). A job loads the model cold every time and stops/restores the Qwen assistant: expect about 4-5 minutes wall time per job (measured, section 4). The UI must show a long-running state and poll; `RuntimeMaxSec` for the worker is 900 s, the relay unit 1800 s.
- Capability check: the route should treat `lustify-inpaint-template.json` present on the relay (a graph with node class `InpaintCropImproved`) as available. The relay does not expose `/object_info` for the crop nodes; availability = `/upload/inpaint` answering (a deliberately bad upload returns 400, a missing route 404).
- Never log or echo the token. Mask and image are user data: do not log bodies.

## 4. Measured results (server test through the relay from the app container)

Test image: 768x768 real output of the lab (upscaled from 512), elliptical mask (about 18% of the area). Both runs: 200 through the relay from the app container, `/view` fetched through the relay.

| Case | Params | Outside grow+blend (>=38 px from mask): max abs diff | Ring mean abs diff (0-5 / 5-10 / 10-20 / 20-30 / 30-38 px outside mask) | Inside mask mean diff | Wall time |
|---|---|---|---|---|---|
| Recolor | strength 0.55, grow 8->tested with 8/10, blend 28, context 1.5 | 0 (0 nonzero pixels) | 10.8 / 7.1 / 0.95 / 0.01 / 0.00 | 12.1 | 270 s (Prompt executed 238 s, cold model load each job) |
| Remove | strength 1.0, grow 10, blend 28, context 2.0 | 0 (0 nonzero pixels) | 13.6 / 9.1 / 1.3 / 0.02 / 0.00 | 32.4 | 276 s (Prompt executed 240 s) |

The change fades monotonically to exactly zero by 20-30 px outside the mask (no step at the blend edge), which is the numeric signature of a seamless stitch. Visual inspection of the images was not done by the server task; the UI owner should eyeball the first real outputs. Memory: host MemAvailable went from 3.36 GB to a minimum of 2.34 GB during a job; no OOM, watchdog did not fire. Negative checks on the relay validator: gray mask, empty mask and wrong-size mask are rejected.

## 5. Not done / left for later

- UI (brush/eraser, SAM click-select) and the app route changes: this contract only.
- Optional tiers from the research doc: color-match toggle, LanPaint, Q4_K_M. Not installed.
- Cleanup of `ComfyUI/input/<job>*.png` and relay `uploads/` is not automated (pre-existing behaviour for img2img too); with full-size inpaint uploads this grows faster. Add a retention sweep before heavy use.

## 6. AI edit planner (`POST /plan`) and real recolor (added 2026-11-22)

Owner requirement: instructions such as "make the car white" are understood by a LOCAL, UNCENSORED LLM (no cloud API).

### Planner model and unit

- Model: `mradermacher/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF` (abliterated Qwen3-VL-4B-Instruct), HF revision `abf99adf548eb2aa6f9a3d56f976968996959e7f`.
  - `Huihui-Qwen3-VL-4B-Instruct-abliterated.Q4_K_M.gguf` (2,497,282,496 B), sha256 `20d58872549c13f5476622d2385027e1b346298558822eca8aa33cb8846d5765`
  - `Huihui-Qwen3-VL-4B-Instruct-abliterated.mmproj-f16.gguf` (836,180,576 B), sha256 `3aedbce332390ff9c4bac496d76490d8c27e4c86b57bed9039d584853a7bfa78`
  - Stored on proxmox02 in `/mnt/truenas/data/grtlabs-ai/planner/` as `model.gguf` / `mmproj.gguf` (+ `SHA256SUMS`, verified).
- Served by the existing llama.cpp build `/opt/grtlabs-assist/runtime/llama-b12551` (mtmd works with Qwen3-VL) as `grtlabs-edit-planner.service` on `127.0.0.1:18192`: `-ngl 99 -ot token_embd.*=CUDA0 -fa on -c 4096 --image-min-tokens 1024 --image-max-tokens 1280`, `DynamicUser`, `MemoryHigh=1300M`, `MemoryMax=1700M`, `MemorySwapMax=0`, `RuntimeMaxSec=300`, `Restart=no`. Never enabled; no always-on LLM.
- On demand and exclusive with image jobs: the relay takes `flock` on `/run/lock/grtlabs-p100-voice.lock` (the same lock `job-control.sh` holds for the whole image job), starts the unit, waits for `/health`, asks once, and always stops the unit again (also on error); `RuntimeMaxSec=300` is the dead-man stop. If an image job holds the lock for more than 30 s, or MemAvailable < 1700 MB, `/plan` answers with the deterministic fallback (`source:"fallback"`, `reason`). An image job submitted while a plan runs simply waits on the same lock (its limit is 600 s). Plans are serialised inside the relay.
- Measured (car photo 2016x1134 downscaled to 1024, mmap, `-ngl 99`): GPU 4.1-4.4 GiB peak; unit cgroup peak 1.30 GiB (includes reclaimable mmap page cache; it hit MemoryHigh and was reclaimed, no OOM); host MemAvailable minimum 2.19 GB from 3.0 GB at start (net about 0.8 GB); cold load about 70 s from NFS; inference about 9 s (about 980 prompt tokens at 125-135 tok/s, about 100-130 generated tokens at 60 tok/s). Wall time per plan about 75-80 s (load dominates), longer when queued behind another plan or an image job. Because Cloudflare cuts any request at 100 s (524), planning is ASYNC end to end (below); no single HTTP request lasts more than a few seconds. `--no-mmap` was not measured (mmap fits).

### `POST /plan` (async) and `GET /plan/{id}`

Same auth as every relay route (192.168.1.108 + bearer). `POST /plan` is `multipart/form-data`, fields in any order, each at most once: `image` (PNG/JPEG/WEBP, 12 MB, any size up to 9.5 MP; it is downscaled to 1024 px for the model), `instruction` (2-1000 chars), optional `mask` (PNG, same dimensions as `image`; when present the target is the masked region). Input is validated synchronously (`400 invalid plan request: <reason>`); then it answers `202 {"plan_id":"<32 hex>"}` immediately and runs the planner in a background task (same `plan_lock`, same GPU flock and fallback behaviour as before; plans queue behind each other).

`GET /plan/{id}` returns `{"state":"pending|running|done|error","plan":{...},"reason":"..."}` (`plan` only when done, `reason` only on error; 404 for unknown/expired id). State is kept in `/var/lib/grtlabs-image/plans/<id>.json` (atomic writes) and swept after 1 h (TTL); a task that was lost to a relay restart reports `error` ("planner stopped (relay restarted)"). A client disconnect never cancels a plan.

App: `POST /api/assistant/images/plan` (session-gated) starts a plan and returns `202 {plan_id}`; `GET /api/assistant/images/plan?id=` (session-gated, `hasValidSession()` first) returns the sanitized `{state, plan?, reason?}`. `lib/plan-client.ts` polls every 2 s for up to 4 min, treats network/5xx errors as transient, and keeps the id in localStorage (`signaldeck.plan.v1`, 10 min) so a reload and re-press of the same instruction resumes instead of replanning.

The plan (a `done` plan is always usable, never a refusal; the stored shape is):

```json
{"op":"recolor","target":"car","color":"white","image_prompt":"a white car, glossy white paint, same lighting and reflections",
 "negative_prompt":"wrong colour, blur, deformed, artifacts","strength":0.45,"grow":8,"context":1.5,
 "box":[248,356,1523,988],"confidence":0.95,"source":"llm","prefill":true,"ms":79222}
```

- `op` is `recolor|replace|remove|add|style`. `color` is a colour name or `#rrggbb` (recolor only, else null). `box` is `[x0,y0,x1,y1]` in pixels of the uploaded image: the mask bounding box when a mask was sent, else the model's grounding (no-mask test: box within about 5% of the true mask bbox), or null.
- Server-side clamp: strength 0.3-1.0 (recolor 0.35-0.6), grow 0-32, context 1.0-3.0, confidence 0-1, text lengths bounded, JSON enforced by llama.cpp `json_schema` (strict). Output is validated; anything invalid makes the whole plan a fallback.
- `source:"fallback"` (with `reason`): keyword parse (English/Italian colour words and verbs) with defaults recolor 0.5 (+prefill), replace 0.85, remove 1.0, add 0.9, style 0.6; `confidence` 0.3; `box` only from the mask.
- The route then sends `strength`, `grow`, `context` and `image_prompt` (as `{{PROMPT}}`) to the inpaint template exactly as in sections 1-2 (`BLEND` stays 28). `negative_prompt` is informational (the template has no negative input).

### Recolor pre-fill (`recolor` field on `/upload/inpaint`)

Diffusion alone at 0.45-0.65 does not turn a dark car white, so a recolor is a two-step edit:

1. `POST /upload/inpaint` gets an optional THIRD multipart part `recolor` (after `image` and `mask`): a colour name (English or Italian, see `recolor.py`) or `#rrggbb`. The relay shifts the colour of the masked pixels in CIELAB before storing the source: shading (L*) is kept, a*/b* are set to the target (neutral targets: white/black/grey/silver remap the lightness range with a gamma that preserves highlights and drop the chroma), highlights and deep shadows are desaturated, the edge is feathered inside the mask only. Pixels outside the mask are untouched (enforced with a hard copy). Unknown colour: `400 ... unknown colour`. The response gains `"recolor": true`.
2. The job then diffuses the pre-filled source at `strength` 0.35-0.6 so the model restores reflections, glass and texture. Because the uploaded file is the pre-filled image, everything downstream (the job, the stitch, the guard's outside-band restore) is unchanged, and the reference for "outside" is the ORIGINAL image.
3. UI flow: `/plan` -> if `prefill` is true upload with `recolor=<plan.color>` -> submit the template with the plan values.

Implementation files on proxmox02 (`/mnt/truenas/data/grtlabs-ai/image/`): `plan.py` (planner client, validation, fallback, lock), `recolor.py` (LAB pre-fill), `relay.py` (routes). Prefill cost: about 1-2 s on a 2.3 MP image (bbox crop only, within the relay's 512 MB limit).

### 6.1 Status and remaining steps (written at the tool-call budget limit)

- Verified: model download + sha256, unit load, `/plan` through `plan.py` (mask and no-mask, `source:"llm"`), LAB pre-fill on the car image (mean L*/a*/b* inside the 20.3% mask: original 45.0/7.1/8.6 -> white 79.2/0.6/2.0, red 44.8/52.9/40.9, black 8.8/1.0/1.2).
- NOT yet verified: full jobs through the relay with measured dE in/outside the mask. The harness was started detached inside the app container (`node /tmp/t/run.mjs`, log `/tmp/t/log.txt`, outputs `/tmp/t/out/<id>.plan.json` and `<id>.result.png`, ids car, b, c, d; about 6 min each). Inputs and originals: `/var/tmp/et/in/` on proxmox02. To finish: copy `/tmp/t/out` back (`docker exec <app> tar c -C /tmp/t out | tar x -C /var/tmp/et`), then compute CIEDE2000/dE76 and mean LAB inside the mask before/after, and max abs diff outside mask grown by 8+28 px (expect 0), with `recolor.rgb2lab`. Acceptance for car: mean L* well above 45 and |a*|,|b*| small inside the mask.
- `grtlabs-edit-planner` is stopped between plans; the relay was restarted with the new routes (backups `relay.py.bak-20261122-193220`).
