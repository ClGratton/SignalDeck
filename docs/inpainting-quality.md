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

## Calibration (2026-11-22/23) - PARTIAL, stopped at tool-call budget

State only; no settings policy derived yet.

Tooling (proxmox02, /root/cal, all reusable):
- cal_server.sh: takes /run/lock/grtlabs-p100-voice.lock, stops Qwen9 if active (restore marker), starts ONE warm ComfyUI on 127.0.0.1:18189 (MemoryMax 1792M, watchdog), runs until /root/cal/STOP. Start: `systemd-run --unit=grtlabs-cal --property=MemoryMax=1792M --property=MemorySwapMax=0 --property=RuntimeMaxSec=10800 /root/cal/cal_server.sh` (run_shell hangs on systemd-run output: wrap in setsid nohup).
- cal.py <batch> <tests.json>: submits Krea inpaint graphs (template + denoise/grow/blend/context/seed/prefill/prompt/mask), applies composite_guard, writes out/<batch>/<id>_{src,ov,res,sbs}.jpg + items.json. Masks in /root/cal/in (m_beard, m_beard_nolip, m_jaw, m_cloth, m_glasses, m_car). Test sets t_beard.json (12), t_other.json (15: shirt/car recolor, leather jacket, hoodie, remove glasses).
- judge.mjs (in CT108 snelkv5 container /tmp, key from env GEMINI_API_KEY, never printed) + push.sh <dir>: JSON scores 0-10. chain.sh judges batches.
- Warm cost: cold load ~230 s, then ~135 s/prompt (16.4 s/it x 8 steps, P100, Q2_K GGUF). 27 tests = ~1 h GPU.
- "neon" = gemini-4-neon (in the server model catalog). Currently 429 quota-exceeded; judge falls back 3.8-flash (503) then gemini-3.5-flash (works).

Results so far (judge gemini-3.5-flash):
- Judge sanity: old Krea A (0.55, beard mask) scored 7/7/7/7/7, SDXL B 6/7/6/7/7. It does NOT flag the lips/face-shape change the owner saw -> judge too lenient. Fix before trusting: add crop of mouth/jaw region from original vs result as extra images, ask for explicit lip/face-shape differences, retry with gemini-4-neon when quota returns.
- Done renders (not yet judged/viewed): beard b01 (0.55 beard mask, repro A, 229 s), b02 (0.35 beard mask), shirt c01, c02 (azzurro prefill, 0.30 / 0.45). Files /root/cal/out/{beard,other}/*_sbs.jpg.
- Server released: grtlabs-cal stopped, lock freed, Qwen9 was inactive at start so nothing to restore.

Remaining: run t_beard b03-b12 and t_other (rest), judge with improved rubric, view best/worst per type, write policy JSON. Hypothesis to test first: mask excluding lips (beard_nolip / jaw) + denoise 0.45-0.55 + prefill is what keeps lips/face shape.

### Calibration update 2026-11-23 (PAUSED by owner; not committed)

Judge fixed (/root/cal/judge2.mjs, push.sh, jl.py builds crops, chainj.sh loops): original + result + mouth crop + jaw crop (boxes from face parsing, in/boxes_portrait.json), model must list differences first, then 0-10 for lips_identical, jaw_and_face_outline_identical, features_outside_request_identical, instruction_followed, realism, seams. Sanity on b01 (0.55 repro): lips 4, outline 4 (before: 7/7/7), b02: lips 4, outline 6. Judge used gemini-3.5-flash every time (gemini-4-neon still 429). Lips stay at 4 whenever stubble touches the lip edge, so the lips score is a floor, not a discriminator; use outline + own eyes.

Beard, mask beard_nolip (lips + 5 px excluded), Krea Q2_K, seed 1234, grow 8, ctx 1.5, blend 28. Scores lips/outline/outside/instruction/realism/seams (flash):
- n02 d0.30 stubble prompt: 4/6/7/6/6/7 - faint stubble, shape kept.
- n01 d0.40: 4/6/7/7/6/7 - subtle, shape kept.
- n03 d0.50: 4/6/7/7/7/7 - visible stubble goatee, lips and jaw outline unchanged by eye. Best of the stubble set.
- n05 d0.40 blend 12: 4/5/7/7/6/6 - lip line slightly softened.
- n04 d0.40 + charcoal prefill: 4/4/7/6/3/3 - flat painted overlay, reject (prefill must not be used for beards).
- "full beard" prompts (owner: request is "add a beard", not stubble): f01 d0.55 short full beard: 4/5/7/7/6/6; f02 d0.65: 4/4/7/7/7/7 (flash: good blending, outline score 4 -> check by eye before trusting). Rendered but NOT viewed by me (files /root/cal/out/rest2/f01_*, f02_*).
Not run: n06 (ctx 2.5), n07 (jaw), n08 (prompt "stubble beard texture"), n10, f03-f06 (d0.75, "medium-length full beard", jaw mask), all other types (recolor, leather, hoodie, glasses; tests in /root/cal/t_rest2.json). No per-type best settings or planner policy JSON yet.
Interim guidance: beard on nolip mask, denoise 0.50-0.65 with a "full beard" prompt, no prefill; strength 0.40 or less is too faint to count as a beard.
Ops: ComfyUI OOM-killed at MemoryMax 1792M once; 2200M ran fine but host hard-reset earlier today under memory pressure, so do not raise it and abort if MemAvailable < 1200 MB (memguard.sh). Server stopped, P100 lock free, GPU 0 MiB, MemAvailable 3072 MB at pause. systemd-run/pgrep -f patterns inside run_shell kill the calling shell itself: use script files.

## Applied defaults (2026-11-23)

Live on proxmox02 (relay.py, plan.py, /opt/grtlabs-segment faceparse.py + segment_service.py; `.bak-<ts>` backups beside each). Krea 2 Q2_K, 8 steps.

- Facial hair (beard/mustache/goatee/stubble) with no user mask: op add; mask = face-parsing beard region minus lips (classes 11-13 dilated 5 px; `/segment/face?part=beard_nolip`); denoise 0.55 (0.50 for stubble; planner may pick 0.50-0.60); grow 8; blend 28; context 1.5; no colour prefill.
- Prompt template: "photo of the same man, same face, same lips and jaw shape, with <requested facial hair>, natural hair texture, same lighting"; planner system prompt instructs the same wording.
- "keep the same shape/face/lips" caps denoise at 0.55 for add/replace. A user-drawn mask is never replaced by the auto face mask. Other ops unchanged (not calibrated).
- Verified without GPU: parameter mappings by unit check; beard_nolip vs lip classes overlap = 0 px on the portrait upload (CPU onnxruntime).

## Context fixes (2026-11-23) - PARTIAL (tool-call budget)

Live on proxmox02 (`/mnt/truenas/data/grtlabs-ai/image`; backups `*.bak-20261123-*-ctx*` beside plan.py and relay.py).

- Fill-first: ComfyUI custom node `Acly/comfyui-inpaint-nodes` pinned at commit 5b7681746fe19e563113d27366ba85236bc1ba5b (v1.4.4). Python reviewed before first load: no network, subprocess, or file writes; only `torch.load(weights_only=True)` for the unused Fooocus head and `torch.jit.load` for big-lama.pt (TorchScript, the model the README names). Model `models/inpaint/big-lama.pt`, sha256 344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9 (file `big-lama.pt.sha256` beside it).
- New strict template `workflows/lustify-inpaint-remove-template.json` (same graph as lustify-inpaint plus nodes 16 LoadInpaintModel and 17 InpaintWithModel on the cropped image/mask; VAEEncode takes LaMa output). Relay mode `inpaint_remove`: used for op remove and replace (not facial hair, not eyewear, override `fill:false` disables). Template validation unchanged in strictness.
- Strengths: remove 0.45-0.6 (default 0.55, grow 20, blend 20), replace 0.75-0.85 (default 0.8, grow 16). Eyewear removal skips LaMa (a lens mask would erase the eyes) and uses the plain template at 0.6 with a whole-person prompt.
- Planner (plan.py): schema field `parts: [{name, box}]` (every named object/garment, own box); prompt rules: no negations, never name the removed object, describe the continuing surroundings; deterministic `clean_prompt()` strips negation clauses and, for remove, words of the target name.
- Relay mask: union of SAM masks per part (a part mask over 85 percent of the image is dropped) plus BiSeNet `cloth` class for garment words on remove/replace.
- GET /edit/<id> plan now carries parts (names), mask_area, grow, blend, context, template, fill, strength.
- Verified: nodes load, planner returns parts for the jacket edit (suit jacket, shirt, tie, clothes-parse; mask area 30.4 percent of the image, previously only half a jacket), prompt sanitizer unit-checked. NOT DONE (budget): none of the 3 test edits was rendered and viewed after the fix (glasses job was generating and was stopped; car and jacket not run). Next: run the 3 edits via CT108 snelkv5 container `node /tmp/ed.mjs <img> "<instruction>"` (script on proxmox02 /root/ctx/ed.mjs, chainB.sh) and view side-by-sides. Note: eyewear mask covers the lenses, so LaMa fill would erase the eyes; frame-only mask is the open item.

## Context fixes (2026-11-23)

- **Live breakage:** the combined template `lustify-inpaint-remove-template.json` (LaMa inside the ComfyUI job) was OOM-killed by the worker cap (MemoryMax 1.75 GiB, no swap). The relay now always uses the plain `inpaint` template. The worker cap was not raised.
- **LaMa as a separate prefill step** (`lama_fill.py`, run by `relay.py` during "preparing"): `systemd-run --wait --collect -p MemoryMax=1536M -p MemorySwapMax=0`, under flock on `/run/lock/grtlabs-p100-voice.lock`. Crop around the dilated mask (context ~1.75x, max 1024 px), big-lama torch.jit on GPU, paste back only inside the dilated mask. If the step fails (or MemAvailable stays under 2.2 GB for 90 s) the edit continues without a fill and `fill_note` in the /edit status says why.
- **Measured:** peak RSS 0.90 GB (324x512 source) and 1.02 GB (1024 px crop), 5-7 s small, 22-24 s at 1024 on GPU. CPU takes over 5 minutes at 1024 px and is not usable. Image job then runs the plain template: remove 0.55, replace 0.8.
- **Original preserved:** the prefill is written to `<id>-prefill.png` and used only as ComfyUI input (`<job>-prefill.png`). `<job>.png` stays the user's original for the composite guard (`worker_job.py` strips `-prefill`) and the /inspect side-by-side.
- **Glasses:** frame-only mask = SAM mask minus its own erosion (band 4-10 px), LaMa without extra dilation, refine at denoise 0.4 with the whole-person prompt. Visual check: glasses gone, eyes kept; slight smoothing around the eyes and slightly heavier eyebrows.
- **Jacket to white t-shirt:** looks right (face intact, plain light t-shirt).
- **Car remove: not solved.** Car body is gone, but the car's shadow and wheels sit outside the mask, LaMa extends them into a dark smear, and the refine pass keeps part of it and hallucinates a kerb. Next: shadow-aware downward dilation (~8-10% of box height) or a ground-shadow mask.
- **Operational note:** do not edit `job-control.sh` while a job is running (bash reads it incrementally; the glasses job was marked error after the image was already validated).

## Inpainting model switch (2026-11-23) - PARTIAL (tool-call budget exhausted; polling of the 15 s run_shell limit ate it)

Goal: replace Krea Q2_K + Crop&Stitch (+LaMa, shadow/frame heuristics) by a real inpainting model, judged by LOOKING, plain masks only.

Done (proxmox02, `/mnt/truenas/data/grtlabs-ai/image`):
- relay.py: `overrides.plain=true` disables frame band, shadow extend, LaMa, thin-mask tweaks and the keep-shape clamp; `overrides.engine` now krea|sdxl|fluxfill (sdxl existed; default still krea). Backups `relay.py.bak-*-plain`, `*-flux`. New template `workflows/lustify-inpaint_flux-template.json` (UnetLoaderGGUF + DualCLIPLoaderGGUF + FluxGuidance 30 + ConditioningZeroOut + InpaintModelConditioning, euler/simple 20 steps, crop 1024) registered as mode `inpaint_flux`; NOT yet rendered.
- SDXL checkpoint sha256 recorded: `ComfyUI/models/checkpoints/lustifySDXLNSFW_v20-inpainting.safetensors.sha256` = 615f2107...f8df84.
- Flux Fill assets downloading by `/root/ctx/dl_flux.sh` (log /root/ctx/dl_flux.log, ~3.5 MB/s): flux1-fill-dev-Q4_K_S.gguf 6.8 GB (YarvixPA mirror rev 78b83f1d, sha 3782c22e...dc8; no Q4_K_M exists there; license "other" = FLUX.1 [dev] non-commercial), t5-v1_1-xxl-encoder-Q4_K_M.gguf (city96, sha 6be2b0b7...1af4), clip_l.safetensors (verified), ae.safetensors (sha afc8e282...e38 = official BFL ae, verified, .sha256 written).
- Driver `/root/ctx/chain_eval.sh <engine> <tag> [cases]` (waits for idle GPU, runs cases via the real /edit; logs /root/ctx/chain_<tag>.log, results s_<tag>_<case>.json). Settings: plain, seed 1234, grow 10, context 1.5 (car, jacket) / 2.5 (face), strength 1.0 (car, jacket), 0.7 glasses, 0.9 beard; SDXL 28 steps cfg 6 dpmpp_2m karras, negative prompt active.

Results:
- SDXL glasses (job bfaf5187, plain mask = SAM lens+frame, denoise 0.7): generation 132 s, 271 s total, worker peak 1.7 GiB (cap 1.75). Frame gone and NO dark outline/seam. BUT eyes changed (wider, darker iris, younger look, heavier brows) and the dark band under the eyes (frame shadow) is still there/heavier. Verdict: seams solved, identity and shadow not.
- SDXL car: first attempt failed in the planner (JSONDecodeError -> fallback, no parts); needs rerun. SDXL jacket and beard: queued in the chain, results in /root/ctx/s_sdxl_jacket.json, s_sdxl_beard.json, NOT viewed.
- Flux Fill fit/speed: not measured. Risk: worker cap 1.75 GiB (SDXL load alone peaks 1.7), RuntimeMaxSec=900.

Next: view s_sdxl_* jobs (vi.ps1 from Bash, not PowerShell: quoting), rerun car, run `chain_eval.sh fluxfill flux` after downloads end (ALLDONE in dl_flux.log), measure RSS/VRAM/s-per-step, decide default per op (nothing changed yet; default stays krea).

### Inpainting model switch, update 2026-11-23 (second agent, stopped at tool-call budget)

Plain masks, seed 1234, judged by looking (side-by-sides in the session scratchpad: sdxl_beard.jpg, sdxl_car.jpg, flux_glasses.jpg).
- SDXL beard (job 4b7f0d80, strength 0.9, ctx 2.5, 275 s): PASS. Real beard + mustache with grey chin, no seam, glasses/eyes/nose/lips shape kept. Beard darker than the hair.
- SDXL car (job 103edd77, strength 1.0, ctx 1.5, mask 22.8%, 261 s): FAIL. It painted a NEW white sedan inside the car-shaped mask. SDXL is not usable for removal with a silhouette mask at strength 1.0.
- Flux Fill (flux1-fill-dev Q4_K_S + t5 Q4_K_M + clip_l + ae, all sha256 verified, FluxGuidance 30, euler/simple 20 steps, no LoRA) on glasses (job 3cb282ff, strength 0.7): frame AND its shadow gone, no seam; eyes regenerated (darker, wider, heavier brows) = identity drift like SDXL. 462 s total incl. cold NAS load (cap 900 s); worker cgroup peak 1792M = the 1.75 GiB cap but no OOM kill (page cache inclusive); VRAM peak 8.5 GB; GPU 62 C after the job, no throttle flags. s/step not isolated.
- Flux Fill car/jacket/beard: chain `/root/ctx/auto_flux.sh` was still running (results /root/ctx/s_flux_{car,jacket,beard}.json, monitor /root/ctx/flux_mon2.log), NOT viewed.
- Kontext: relay.py engine=kontext + template `workflows/lustify-inpaint_kontext-template.json` added (UnetLoaderGGUF Q4_K_S, LoraLoaderModelOnly removal LoRA strength 1 for remove else 0, ReferenceLatent + SetLatentNoiseMask, FluxGuidance 2.5, 22 steps, crop 768, prompt = the user instruction); builder `/root/ctx/mk_kontext_tpl.py`, relay backup `relay.py.bak-*-kontext`, relay restarted, syntax OK, NEVER RENDERED. Download `/root/ctx/dl_kontext.sh` (QuantStack rev 2d083027, sha cc22ff7a...; windsingai LoRA rev bca2b6d4, sha 32385740...) is SIGSTOPped at 1.2/6.8 GB by design (frees bandwidth); auto_flux.sh sends CONT after the Flux download, so it should be running; check dl_kontext.log for ALLDONE.
- Defaults unchanged: Krea stays default; no op switched. The Flux removal LoRA (xiaozhijason, civarchive) was not fetched.
- Next: view s_flux_car/jacket/beard; when Kontext ALLDONE run `/root/ctx/chain_eval.sh kontext kon glasses car jacket beard` (strength 1.0; glasses 1.0); then decide per op. Stop /root/ctx/mon2.sh when finished.
