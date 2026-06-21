// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ONLY: write a file atomically (temp file in the same dir, then rename).
//
// Two reasons this is the ONLY way the app should write its data/ JSON:
//
//  1. Crash-safety — a reader never sees a half-written file; the rename is
//     atomic, so the target is always either the old or the new whole file.
//
//  2. Permission recovery — rename(2) needs write permission on the DIRECTORY,
//     NOT on the (possibly differently-owned) existing target file. An earlier
//     container generation that ran as ROOT created data/*.json owned by root;
//     when the app later runs as a non-root user it can still CREATE new files in
//     data/ (so newer features worked) but a plain writeFileSync OVER a root-owned
//     file fails with EACCES. That silently broke session persistence (logins
//     didn't stick → bounce back to /login) and 500'd the settings save. Writing a
//     fresh temp file and renaming it over the old one replaces the root-owned
//     file with an app-owned one, so the app heals itself on the next write.
//
// Throws on failure; the caller decides whether to surface it (settings) or
// swallow-and-log it (the throttled stores).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

let counter = 0;

export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Unique temp name in the SAME directory (rename across dirs isn't atomic).
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${counter++}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Clean up the temp file so a failed write doesn't litter data/.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}
