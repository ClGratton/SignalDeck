# Inpainting UI handoff (2026-11-22)

Done: route flow (`app/api/assistant/images/route.ts`, env `COMFYUI_INPAINT_WORKFLOW_PATH`, default `<dir of IMG2IMG path>/lustify-inpaint-template.json`; template copy in `deploy/image-provider/`, already placed in the app container volume `/app/data/image-provider/`), `components/console/InpaintEditor.tsx`, `lib/sam-client.ts` (SAM 2.1 Tiny, wasm), Dockerfile `sam` stage (pinned revision + sha256), `scripts/vendor-ort.mjs`, cache headers in `next.config.mjs`.

Remaining:
1. Confirm deploy ycaiou8lgzhxapuxtziaekec finished: `curl -I http://192.168.1.108:3000/models/sam2.1-tiny-f8b86bc/encoder.ort` must be 200, content-length 134656368, decoder.onnx 16559905, /vendor/ort/ort-wasm-simd-threaded.wasm 200.
2. Look at the real inpaint output: proxmox02 `/mnt/truenas/data/grtlabs-ai/image/ComfyUI/output/Grtlabs_00014_.png` (job 4d8d8ab2..., red leather, strength 0.7, ellipse mask centre 256,300 on Grtlabs_00009_.png). Judge seams by eye (copy locally; an ad-hoc LAN http.server was denied by the permission classifier, use another transfer).
3. Click-test the editor in the signed-in console (Image pane > "Edit a photo"), incl. a 375 px phone.
4. Optional: WebGPU encoder (`sam2.1-tiny-encoder-webgpu.ort`, sha ceb74f07...) is not wired; wasm only.

## Rework 2026-11-22 (after phone test in Brave)

- Failure cause: relay `/upload/inpaint` returned 400 (relay log 17:56:31, `status=400`; the relay hides the reason). Prime suspect: Brave canvas farbling perturbs `toBlob`/`getImageData` pixels, so the exported mask was not strictly 0/255 (relay: "mask not binary"). The mask is now an authoritative `Uint8Array` encoded by `lib/png-mask.ts` (1-bit PNG, no canvas readback), with client-side checks mirroring relay rules (64..3072 px, <= 9.5 MP, mask size == image size, non-empty).
- Flow: uploading an image opens the editor directly; results have "Edit". Taps/boxes commit straight into the mask (Select adds, Subtract removes); undo covers brush and selections.
- Browser SAM removed (onnxruntime-web, sam-client, vendor-ort, Dockerfile `sam` stage, /models, /vendor/ort headers). Selection is server-side via `app/api/assistant/images/segment/route.ts` -> relay `/segment/embed` + `/segment/predict` (embed on editor open; 404 unknown key -> re-embed once). Needs the relay segment endpoints to be live; if absent the editor shows a note and Brush keeps working.
- UI redesigned with console tokens (segmented tools, icon buttons, token-styled sliders, sticky primary action).
- To verify on the real deployment: tap an object with the phone, then Generate (relay segment endpoints must exist).
