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
3. Poll `GET /history/{prompt_id}` (empty `{}` while pending/running; then `status.status_str` success/error) and fetch the result with `GET /view?type=output&filename=<name>` exactly as today. The output is the full-resolution stitched PNG (same size as the uploaded image). Pixels outside the grown+blended mask are bit-identical to the uploaded image. The result can be re-uploaded as the next source for chained edits.

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
