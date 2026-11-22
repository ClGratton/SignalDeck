# Inpainting UI handoff

State (2026-11-22): server-driven `/edit` pipeline + one continuous stage are implemented. See docs/inpainting-api.md section 7.
- Relay (proxmox02 /mnt/truenas/data/grtlabs-ai/image/relay.py, backups relay.py.bak-20261122-211019 and ...-b): `/edit`, `/edit/{id}`, `/edit/{id}/cancel`, resume on restart.
- App: app/api/assistant/images/edit/route.ts, lib/edit-client.ts, components/console/ImagePane.tsx (owns state, polls), InpaintEditor.tsx (stays mounted and becomes the stage via the `run` prop), css block "One continuous stage".
- Removed: lib/plan-client.ts, app/api/assistant/images/plan (client-driven chain). Relay `/plan` etc. kept for compatibility.
Remaining: (1) confirm the real run reached `done` (edit 8daf2b6140954e2e8eb65b6916993083, state file /var/lib/grtlabs-image/edits/<id>.json); (2) real-phone check of the stage transition and a long offline period;
(3) optional: show a real mask outline once a final mask is returned at full resolution; (4) the 'Change' re-run re-plans (about 80 s) when the user gave no mask.
