# SignalDeck image workspace: masked editing / inpainting research and design

Date: 2026-11-22. Research only; nothing changed on the lab. Scope: general object/region edit and removal (replace/remove objects, recolor, change materials). Nothing person-specific.

## 0. What the current stack actually is (verified read-only on proxmox02)

- The base model is NOT SDXL and NOT Flux. It is **Krea 2** (12B DiT, Qwen3-VL text encoder, Qwen-Image VAE). The template loads `UnetLoaderGGUF(lustify-v10-krea-turbo-Q2_K.gguf)` + `CLIPLoader(qwen3vl_4b_fp8_scaled.safetensors, type=krea2)` + `VAELoader(qwen_image_vae.safetensors)`; KSampler euler/simple, 8 steps, cfg 1, `ConditioningZeroOut` as negative. Img2img template = `LoadImage -> VAEEncode -> KSampler(denoise 0.65)`. Placeholders `{{PROMPT}}`, `{{SEED}}`, `{{IMAGE}}`.
- Files in /mnt/truenas/data/grtlabs-ai/image/assets: GGUF 5.02 GB, text encoder 5.24 GB, VAE 254 MB.
- `custom_nodes/ComfyUI-GGUF` is the **molbal fork** (stock city96 does not load Krea 2 GGUFs). ComfyUI core has `class Krea2` in supported_models.py (checkout dated 2026-11-20).
- Worker: `--gpu-only --disable-pinned-memory`, MemoryMax=1792M, MemorySwapMax=0, RuntimeMaxSec=900. P100 16 GB (4.6 GB was in use by something else at check time); host RAM 13.9 GB total, ~2.5 GB available.
- The app route `app/api/assistant/images/route.ts` picks the workflow by whether an image was uploaded (`imageWorkflowPath()`), requires `"{{PROMPT}}"`/`"{{IMAGE}}"` tokens, posts to `/prompt`.

Consequence: all SDXL/Flux-era advice (SDXL inpaint checkpoint, Fooocus inpaint patch, BrushNet/PowerPaint, Flux Fill, Flux ControlNet-inpaint) does NOT apply. There is no official Krea 2 "Fill" model.

## 1. Inpainting approach

### Options for Krea 2, and verdict

| Option | Works with our Krea 2 Turbo Q2_K? | Verdict |
|---|---|---|
| Native fill/inpaint model (Flux Fill, SDXL inpaint, Fooocus patch, BrushNet, PowerPaint) | No: different architectures; no Krea 2 fill model | Not applicable |
| Krea 2 Inpaint Edit LoRA (`Cierpliwy/krea2-inpaint-edit`, nodes `ostris/ComfyUI-Krea2-Ostris-Edit`) | Needs **Krea-2-Raw** base (not Turbo, not our Lustify fine-tune; GGUF untested), adds reference-image tokens | Not viable on P100/Q2; maybe later |
| Krea2 AnyPaint (`alexw5702-afk/krea2-anypaint`, adapter `yijunwang2/krea2-anypaint`, `krea2_anypaint_rank32.safetensors`) | Written for Krea 2 Turbo, but repo is brand new (account 0 days old, 0 stars per RunComfy page) | Unvetted; experiment only after reading the code |
| ControlNet inpaint | None for Krea 2 | Not applicable |
| Latent-mask sampling on the existing model (SetLatentNoiseMask + DifferentialDiffusion) | Yes, core nodes only | **Baseline, build first** |
| LanPaint (`scraed/LanPaint`, `LanPaint_KSampler`) | Lists Krea2 (Turbo) as supported; GGUF not mentioned; ~5x slower at NumSteps~5; GPL-3.0 | **Optional quality tier** for hard edits |
| Inpaint-CropAndStitch (`lquesada/ComfyUI-Inpaint-CropAndStitch`) | Model-agnostic (any sampling graph) | **Mandatory wrapper** (resolution + seams) |

### Recommended combination (seamless and fits hardware)

1. **Inpaint Crop** (crop to mask + context, resize to ~1024 working size) -> sample only the crop -> **Inpaint Stitch** (resize back, paste only inside the blended mask; original pixels untouched outside). This is the biggest contributor: the model sees the region at native resolution and the untouched area stays pixel-identical.
2. Sampling inside the crop: `VAEEncode` crop image, `SetLatentNoiseMask` with the crop mask, `DifferentialDiffusion` on the MODEL (soft mask becomes per-pixel denoise strength, removing the hard-edge look), KSampler denoise ~0.45-1.0 by edit type. Keep Turbo settings: 8 steps, cfg 1, euler/simple. `InpaintModelConditioning` (recommended by the lquesada page for denoise < 1) targets models with inpaint conditioning channels; verify it is harmless on Krea 2, otherwise use SetLatentNoiseMask.
3. Seams/color: stitch mask blur (`mask_blend_pixels`), mask grow, optionally color-match the generated crop to the unmasked ring of the original (KJNodes `ColorMatch` or an own Lab mean/std match) before stitch. Poisson blending is not needed when the sampler sees real context and the stitch is feathered; keep color match as a toggle.
4. Hard tier: replace KSampler with `LanPaint_KSampler` (Steps ~20, NumSteps 2-5, EarlyStop 1-5) when the baseline fails (object removal, large replacement). Expect 3-5x time; must fit RuntimeMaxSec=900. LanPaint binarizes masks, so keep Differential Diffusion for the fast tier.
5. Avoid `VAEEncodeForInpaint`: it greys the masked area, forces denoise 1, and loses color/structure hints. SetLatentNoiseMask keeps the original latent under the mask, so recolor/material edits at denoise 0.4-0.7 work.

### Files to download
Nothing new for models in the baseline (GGUF 5.02 GB, TE 5.24 GB, VAE 254 MB already present). Segmenter is browser-side (section 2). New server installs are small pure-Python node packs:
- `lquesada/ComfyUI-Inpaint-CropAndStitch` (GPL-3.0): nodes "Inpaint Crop" / "Inpaint Stitch". Default device mode is documented inconsistently (CPU vs GPU): set explicitly.
- Core nodes already present: DifferentialDiffusion, GrowMask, FeatherMask, SetLatentNoiseMask, ImageCompositeMasked, LoadImageMask.
- Optional: `kijai/ComfyUI-KJNodes` (ColorMatch; verify in object_info), `scraed/LanPaint` (GPL-3.0).
Install by git clone into custom_nodes ahead of time (the worker runs `--offline`); avoid nodes that download models at import.

### Pascal / hardware notes
- No bf16/fp8 tensor cores. The worker already runs the fp8-scaled text encoder and the GGUF (dequantized to fp16), so these work today; stay fp16. Anything requiring bf16, FlashAttention-3, fp8 matmul, or Hopper/Ada Triton kernels will not run. A `cpu-notriton` directory exists in the image dir, so Triton was already a problem: do not add nodes that need Triton/xformers.
- Q2_K is the quality floor ("visible degradation but usable" per Krea-R-Turbo card). Inpainting exposes artifacts. Q4_K_M (~7.5 GB, from the base Krea 2 Turbo GGUF family; Lustify's Civitai page mentions its own Q4 GGUF) fits VRAM easily; the constraint is host RAM during load.
- Working resolution: crop resized to ~1024 (or 768 for speed); source photo size does not drive VRAM.

## 2. Light object-aware selection

| Model | Size (encoder + decoder) | Notes | License |
|---|---|---|---|
| SAM 2.1 Hiera-Tiny ONNX (`Cr7z676/sam2.1-hiera-tiny-onnx`) | encoder 134.7 MB (.ort) + decoder 16.6 MB | Measured on Apple Silicon, onnxruntime-web wasm 4 threads: encode 2.75 s, click decode 49-74 ms. Image is stretched to 1024x1024 (no padding). Encoder outputs image_embed [1,256,64,64], high_res_feats_0 [1,32,256,256], high_res_feats_1 [1,64,128,128]; decoder takes point_coords [1,N,2] (1024 space), point_labels, mask_input [1,1,256,256], has_mask_input; returns masks [1,3,256,256] + iou | Apache-2.0 |
| MobileSAM (TinyViT) | ~5M-param encoder (file size unverified, likely tens of MB) + 3.9M decoder; 12 ms/image on GPU | Official ONNX export script for decoder; lower quality on thin/occluded objects | Apache-2.0 |
| SlimSAM-77 | ~14 MB INT8 (aggregator claim) | Lowest quality | Apache-2.0 |
| EfficientSAM / EfficientViT-SAM | not verified | not researched in depth | check |
| SAM 3 (`sam3.safetensors`) | large | Text-prompted detect; too heavy for browser and this host | check |

Recommendation: **SAM 2.1 Hiera-Tiny in the browser** (onnxruntime-web, WebGPU if present, wasm fallback), encoder once per source image, decoder per click/box.
- Zero load on the RAM-tight host and on the P100 (exclusive to the transient ComfyUI worker; assist-qwen is stopped during jobs).
- 152 MB one-time download, cached in IndexedDB/Cache API; Apache-2.0. Serve from the app origin, not hot-linked.
- Latency: ~2.7 s encode (wasm, desktop-class), decode under 100 ms. WebGPU figures not found. Phones will be slower: budget 5-15 s with a spinner; MobileSAM is the fallback if memory or time is too high on the owner's phone.
- Server-side SAM 2.1 on the P100 is possible but competes for GPU/RAM and needs another service; only if phones prove too slow.
- Text-prompted selection (GroundingDINO / Florence-2 + SAM): Florence-2-base (~230M params) or GroundingDINO-tiny (~170M) are not browser-light and cost host RAM. Defer; not needed for MVP.

## 3. Proposed design

### UI (ImagePane.tsx)
- Edit mode on an uploaded/generated image. Canvas stack: image, mask overlay (red ~50% tint), cursor.
- Tools: Brush (size, hardness), Eraser, Click-select (SAM: left click = add point, right click / long-press or a "-" toggle = subtract point, drag = box prompt), Invert, Clear, Undo/Redo.
- Mask state: an offscreen alpha canvas at source resolution (cap long side ~2048). SAM input is the image stretched to 1024x1024. SAM output 256x256 logits are upscaled bilinear to source size, thresholded at 0, then unioned (add) or subtracted from the mask.
- Controls: Grow (0-64 px), Feather (0-64 px, preview only), mask preview toggle, Strength slider (maps to denoise), prompt ("what should appear here"), and a "Remove object" button that uses a neutral background prompt with denoise 1.
- Export: PNG source as-is + PNG mask (white = edit region, hard 0/255). The server applies grow/feather so results are reproducible; partially transparent masks can leak original content.

### API / relay
- `POST /api/assistant/images` accepts multipart `image` (existing), new `mask` (PNG), and params `strength`, `grow`, `blend`, `mode` ("inpaint" | "remove"). Reject mask without image; size caps (e.g. 8 MB each, long side <= 4096).
- Write image and mask to the ComfyUI input dir (relay upload endpoint; add one if missing) and substitute `{{IMAGE}}`, `{{MASK}}`, `{{STRENGTH}}`, `{{GROW}}`, `{{BLEND}}` in a new template `lustify-inpaint-template.json` (`LoadImageMask`).
- `imageWorkflowPath()` gets an inpaint sibling used when a mask is present; the capability check also verifies that the Crop/Stitch nodes exist via `/object_info`, and the UI hides Edit if not.
- Output the stitched full-resolution PNG (lossless) so untouched regions are never re-encoded; the result can become the next source for chained edits.

### Workflow outline (node names)
```
UnetLoaderGGUF -> DifferentialDiffusion -> MODEL
CLIPLoader(type=krea2) -> CLIPTextEncode({{PROMPT}}) -> POS ; ConditioningZeroOut -> NEG
LoadImage({{IMAGE}}) ; LoadImageMask({{MASK}}, channel=red)
Inpaint Crop(image, mask,
   context_from_mask_extend_factor=1.5..2.0,
   mask_fill_holes=true, mask_expand_pixels={{GROW}} (6-12),
   mask_blend_pixels={{BLEND}} (24-32), mask_hipass_filter=0.1,
   output_resize_to_target_size=true 1024x1024 (or 768), output_padding=32,
   upscale=bicubic, downscale=bilinear)
   -> cropped_image, cropped_mask, stitcher
VAELoader(qwen_image_vae) ; VAEEncode(cropped_image)
SetLatentNoiseMask(latent, cropped_mask)
KSampler(MODEL, POS, NEG, latent, steps=8, cfg=1, euler/simple, denoise={{STRENGTH}})
VAEDecode
[optional] color match decoded crop to unmasked ring of cropped_image
Inpaint Stitch(stitcher, decoded) -> SaveImage
```
Widget/class names come from the lquesada README labels; confirm exact names against `/object_info` before implementing.

### Avoiding seams: starting settings
- Always crop+stitch; never VAE-roundtrip the whole photo.
- Mask: binary in; server-side expand 6-12 px, blend 24-32 px (~3% of the crop), fill holes on, hipass 0.1.
- Context factor 1.5 for small objects, 2.0 for removal (needs surrounding texture). Larger factor shrinks the object in the 1024 working area (less detail).
- Denoise: recolor/material 0.45-0.65; replace object 0.8-0.9; remove 1.0. With denoise < 1 the effective steps shrink: try 10-12 steps at ~0.5.
- DifferentialDiffusion on the model so the blurred edge becomes graded denoise.
- Color shift: only masked pixels and the feathered ring change; if a tint shows, enable color match against the ring or reduce denoise.
- PNG throughout; no JPEG intermediates.

### Phases
1. Server: install Crop/Stitch, add inpaint template and mask upload, test with a hand-made mask via curl.
2. UI: brush/eraser/invert/preview and mask export.
3. UI: SAM 2.1 Tiny click/box selection with add/subtract.
4. Tuning on 4-6 reference photos; optional LanPaint tier and Q4 test.

## 4. Risks

- Host RAM: worker MemoryMax=1792M with a 5.0 GB GGUF + 5.2 GB TE. It works today (mmap/page cache), but extra nodes and CPU image ops add resident memory. Use Crop/Stitch GPU mode, cap images ~4096 px, watch journalctl for OOM kills.
- Q2_K quality: textures may show artifacts; Q4_K_M (~7.5 GB mapped) is tight against the RAM cap: test before committing.
- NFS load: ~10.5 GB read per cold job (GGUF + TE); RuntimeMaxSec=900 covers load + sampling. The baseline adds only seconds (crop/stitch); LanPaint may break the budget.
- LanPaint with Krea 2 Q2 GGUF untested; GPL-3.0.
- Unvetted code: custom nodes execute arbitrary Python on a host that holds elevated tokens; review before installing. Krea2 AnyPaint is a brand-new account with no stars.
- Browser SAM: 152 MB first download; phone memory and WebGPU availability vary; need wasm fallback, cancel and spinner. The stretch-to-1024 preprocessing must match exactly or masks are offset.
- Licensing: CropAndStitch and LanPaint are GPL-3.0 (server-side separate nodes; matters only if redistributed). Krea 2 weights and GGUFs follow the "Krea 2 Community License" (read before any redistribution/commercial use; Lustify is a fine-tune). SAM 2.1, MobileSAM, SlimSAM are Apache-2.0.

## Not verified (follow up before building)
- Exact class names/widgets of the Crop/Stitch nodes and ColorMatch in this ComfyUI build (`/object_info`).
- Behaviour of SetLatentNoiseMask + DifferentialDiffusion on Krea 2 Q2_K (needs test renders).
- EfficientSAM / EfficientViT-SAM sizes and ONNX availability; WebGPU latency for SAM 2.1; MobileSAM encoder ONNX size.
- Lustify Q4 GGUF availability and loader compatibility.

## Sources

- Lustify / Krea 2: https://civitai.com/models/573152/lustify , https://huggingface.co/molbal/krea2-gguf , https://huggingface.co/Abiray/Krea-2-Turbo-GGUF , https://huggingface.co/vantagewithai/Krea-2-Turbo-GGUF
- Krea 2 inpaint paths: https://comfyui-wiki.com/en/news/2026-09-24-krea2-inpaint-edit , https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit , https://www.runcomfy.com/comfyui-workflows/krea-2-turbo-inpainting-in-comfyui-lanpaint-sam3 , https://www.runcomfy.com/comfyui-nodes/krea2-anypaint , https://www.kombitz.com/2026/07/19/how-to-use-krea-2-turbo-gguf-for-inpainting-in-comfyui/
- LanPaint: https://github.com/scraed/LanPaint (arXiv:2502.03491)
- Crop and stitch: https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch
- ComfyUI inpaint basics: https://docs.comfy.org/tutorials/basic/inpaint
- SAM 2.1 ONNX: https://huggingface.co/Cr7z676/sam2.1-hiera-tiny-onnx , https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models , https://huggingface.co/Geo-IA/evo-sam2.1-onnx
- MobileSAM: https://github.com/ChaoningZhang/MobileSAM
- Local files inspected: /mnt/truenas/data/grtlabs-ai/image/{workflows/lustify-img2img-template.json, relay.py, job-control.sh, assets/}; app route app/api/assistant/images/route.ts
