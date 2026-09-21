# SURAKSH demo media

This directory is reserved for legitimate, non-sensitive CCTV test media used by
the hackathon demonstration. Do not commit private surveillance footage or
generated detection JSON.

The local Unified Viewer supports these explicitly allowlisted, browser-compatible replay sources:

- `OP.mp4`
- `vms-a.mp4`
- `vms-b.mp4`

The `anpr-vms-a.mp4` and `anpr-vms-b.mp4` files are retained for offline ANPR
experiments, but their FMP4 encoding is not playable by the browser viewer.
Use the H.264 `vms-a.mp4` and `vms-b.mp4` versions for the viewer.

Place the source clips in this directory. They are served only in local demo
mode and are intentionally ignored by Git. The Unified Viewer loops the source
videos while displaying a separate precomputed YOLO26n + timestamp-aware track
overlay, so inference does not compete with video playback. Prepare or refresh
all local analysis caches with `python scripts/prepare_op_replay.py --all`.
Caches are written under `.runtime/demo-replays/` and are also ignored by Git.
The default analysis sampling interval is 10 source frames; set
`SURAKSH_DEMO_REPLAY_STEP` to change it before generating caches. A smaller
interval improves temporal detail but takes longer to prepare and produces
larger cache files.

Track totals are estimates from anonymous tracker IDs, not verified unique
people or vehicles. A missing or unreadable source video is omitted from the
viewer catalog.

Recommended: use a rights-cleared sample from an openly licensed dataset and
record its source and licence in `SOURCE.md` beside the media. The files are
ignored by Git by default because source footage may be large or sensitive.
