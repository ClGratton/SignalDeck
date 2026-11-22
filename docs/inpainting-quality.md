# Inpainting quality A/B (2026-11-22)

Failure: "add a beard" with an auto mask over the whole lower face redrew a new face (4 eyes).
Cause: mask too large + strength 0.9 + prompt describing only the beard. Not the model.

## Results (visually judged, side-by-side JPEGs ab_*.jpg)
| Case | Variant | Result | Time |
|---|---|---|---|
| 1 beard | A: Krea Q2_K, face-parsing beard mask, add 0.55, whole-person prompt | PASS: same man, 2 eyes, glasses intact, natural grey stubble + mustache, no seams | ~298 s job (cold load) |
| 1 beard | B: Lustify SDXL inpainting v2.0, same mask, denoise 0.95, 28 steps cfg 6 | identity OK, but handlebar mustache + goatee, ignores "short" | 192 s |
| 2 car white | A / B | queued in /root/ab/batchS.sh on proxmox02, NOT viewed (budget); the car recolor with Krea was already confirmed working earlier | - |
| 3 removal, 4 shirt | A / B | NOT run (budget) | - |

## Decision
- Beard / face-part edits: variant A (Krea + face-parsing mask + lower add strength + whole-person prompt). It is now the default.
- SDXL inpaint is installed and selectable (`overrides.engine = "sdxl"`), not default: it fits the 1.8 GB worker cap (1.7 GB peak), 192 s, but over-stylised the beard. Untested for removal/recolor: do that before switching any op.
- Real negative conditioning on Krea: not done (cfg 1 turbo; ConditioningZeroOut kept).

## What changed (proxmox02)
- /opt/grtlabs-segment/faceparse.py (BiSeNet resnet18, yakhyo/face-parsing v0.0.2, MIT, sha256 0d9bd318...e33f in models.sha256), route POST /segment/face?part=beard|cloth|hair|skin|face (CPU, ~1.1 s). segment_service.py backup `.bak-20261122-faceparse`.
- relay.py: facial-hair instructions without a mask auto-use /segment/face; overrides engine/grow/context/seed; template workflows/lustify-inpaint_sdxl-template.json (+ validate). Backups relay.py.bak-20261122-*-sdxl and *-face.
- plan.py DEFAULTS: add 0.55, replace 0.75, remove 0.9 (recolor 0.45 unchanged); planner prompt asks for whole-person prompts. Backup plan.py.bak-20261122-*-ab.
- Model: ComfyUI/models/checkpoints/lustifySDXLNSFW_v20-inpainting.safetensors (HF rev 4e6f2a5027fc95f334b17f445f9b2da288f281c8; sha256 file written next to it).

## Remaining
1. View car-white A/B results (jobs from /root/ab/batchS.log), run removal + shirt (use cloth mask for shirt) for both engines.
2. Re-run case 1 through the plain /edit path (no mask) to confirm auto face mask routing end to end.
3. Optional: 2 seeds + face-similarity pick; SDXL for removal if it beats Krea.
