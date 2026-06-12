# Backend credentials — privilege levels

The homelab backend keys live in `.env.local` (or, now, the dashboard **Settings**
panel, which writes runtime overrides to `data/service-config.json`). Both are
server-only and never reach the browser except through the re-auth-gated reveal.

By design the keys are **least-privilege**, because the same credential is read by
both the public landing (sanitized aggregate counts) and the authenticated
console. That is safe for *reading*. For the operator **assistant to act**
(`lab_request` over any backend, plus the `guest_power`/`ha_service` shortcuts),
some of them need more scope.

This is the table to act on. "Read" = what the panels need today. "Act" = what
the assistant needs to perform the confirmed proposals.

| Backend | Env var(s) | Read needs | Act needs |
|---|---|---|---|
| **Proxmox** | `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` | `Sys.Audit` + `VM.Audit` on `/` (read `cluster/resources`) | power: `VM.PowerMgmt`; **destroy**: `VM.Allocate`; reconfigure: `VM.Config.*`; disks: `Datastore.Allocate` |
| **Home Assistant** | `HOMEASSISTANT_TOKEN` | any long-lived token can read `/api/states` | a token minted by an **admin** user can call services (`light.turn_off`, etc.) — non-admin tokens 403 on service calls |
| **TrueNAS** | `TRUENAS_API_KEY` | a "Readonly Admin"-role key reads pools/datasets/temps | no write actions are wired yet; a future action tool would need a `FULL_ADMIN`/write-role key |
| **Jellyfin** | `JELLYFIN_API_KEY` | server API key reads sessions | no action tools wired |
| **Cloudflare** | `CLOUDFLARE_API_TOKEN` | `Zone → Analytics → Read` | read-only; no actions |
| **SSH (run_shell)** | `SSH_HOST/PORT/USER/PASSWORD or PRIVATE_KEY` | — | shell on the host for what REST can't do (`pct exec`, logs); point at the Proxmox node. A user that can run `pct`/`qm` (root) reaches every guest. Always confirm-gated. |

## What to change for the assistant to actually act

1. **Proxmox — the one that matters for "delete mealie".** The current token can
   read and (since `guest_power` works) power guests. To let `lab_request`
   destroy/reconfigure a guest, the token's user needs VM-admin scope. Two clean
   options, least-privilege first:
   - Create a Proxmox **role** (e.g. `LabOperator`) with `VM.Audit, VM.PowerMgmt,
     VM.Config.Disk, VM.Config.CDROM, VM.Config.Options, VM.Allocate,
     Datastore.Audit` and assign it to the token's user on `/`. Keep
     *Privilege Separation* on the token but grant the token the same role.
   - Or, simplest (broader): give the token's user the built-in **`PVEVMAdmin`**
     role on path `/vms`.
   Avoid full `root@pam` / `Administrator` unless you want the assistant able to
   touch node/cluster config too. Leave `PROXMOX_VERIFY_TLS=true` (a real cert
   behind the tunnel) — only flip it for a self-signed host you trust on the LAN.

2. **Home Assistant.** If service calls 403, mint the long-lived token from an
   **admin** user (Profile → Long-lived access tokens). That single token both
   reads states and calls services.

3. **TrueNAS / Jellyfin / Cloudflare.** No elevation needed today — they have no
   action tools. If a write tool is added later, raise the TrueNAS key's role to
   a write role then.

## Security note

Putting an elevated Proxmox token in this app means a credential that can destroy
guests is read by the same process that serves the public landing. The mitigation
is structural: the token is **server-only** (never sent to the browser), the
public routes only ever call read endpoints (`cluster/resources`, sanitized
aggregates), and every mutation is **confirm-gated** — the assistant can only
*propose*; nothing runs until you click Confirm in the console. If you want a
hard wall, run a separate read-only token for the public build and the elevated
token only on the authenticated deployment; the code reads each via `cfg()` so
swapping per-environment is a config change, not a code change.
