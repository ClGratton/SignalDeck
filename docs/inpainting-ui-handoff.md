# Inpainting UI handoff (AI edit planner wiring)

Done: app route `app/api/assistant/images/plan` (session-gated, relay token server-side), `lib/plan-client.ts`
(downscale to 1024 px, box rescale), InpaintEditor single instruction field -> plan -> auto box selection -> plan card
(5 s auto-continue, Hold, Edit plan, Recolor/Replace/Remove override, fallback note) -> upload with `recolor`,
ImagePane saves the plan line for reload resume. Verified against a dev stub relay (order image, mask, recolor confirmed).

Remaining:
- Real e2e through the deployed relay: script `/tmp/t2/e2e.cjs` ran inside the app container (log `/tmp/t2/e2e.log`,
  result `/tmp/t2/result.png`; container id changes after a deploy). Check the log for `DONE`; the plan call was still
  loading the model at the time of writing. Remove `/tmp/t2` in the container and `/var/tmp/e2e.cjs`, `/var/tmp/car.png` on proxmox02 afterwards.
- Cloudflare proxy read timeout is 100 s; a cold /plan takes 75-80 s, close to that limit when reached through the public hostname.
