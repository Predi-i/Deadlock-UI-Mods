# HUD-Dumper

Standalone diagnostic source for streaming a live HUD tree. It records panel IDs,
types, basic flags, and `Label`/`TextEntry` text. **Full native class enumeration
is not implemented:** the current client capture found `GetClasses()` unavailable
on every panel. The Windows Python receiver rebuilds the nested `domTree` JSON used by the
QOLLOCK offline profiler. This is a structural capture, not an FPS measurement.

See [class enumeration investigation](CLASS_ENUMERATION.md) for the evidence and
the remaining requirement. A complete packet set must not be presented as a
complete capture of classes.

## Capture procedure

1. The maintainer compiles and repacks this folder using the repository's normal
   build process, then enables the resulting mod. Source edits alone do not
   update the client. The override of `base_hud.xml` must be combined with other
   enabled mods' additions if they override the same resource.
2. Run `python HUD-Dumper/tools/save_dump.py --label hero-testing` from the
   repository root, or launch `tools/save_dump.bat` inside this folder. Python
   uses only the standard library. Clipboard watching requires Windows.
3. Enter the intended HUD state and press **M** once. Avoid another installed
   diagnostic mod that also binds M. Keep the receiver running before export
   starts; the clipboard is replaced by small batches while collection continues.
4. Wait for the receiver's **Saved verified complete packet set** message. Its
   output path points to a new capture under `captures/`. Scenario labels can
   be changed with `--label match` or `--label hideout`; `--output-dir` selects
   another directory. Previous captures are never overwritten.
5. Inspect capture warnings before using it. Select this file explicitly in
   the profiler; the old `deadlock_hud_dump.json` is not replaced automatically.

V4 serializes into bounded batches, dispatches each batch before continuing
collection, and releases its text from the client. It does not retain the entire
JSON before export or apply the old cumulative character limit. Full HUD captures
use this path; taking each HUD subtree separately is optional.

The receiver journals each validated batch immediately to a
`hud_packets_<session>_*.jsonl.part` file in the output directory. These journals
survive interruption and contain sequence numbers, checksums and payloads; they
are recovery artifacts, not completed profiler captures. Only a completion
marker plus every batch index permits reconstruction into one final JSON.
Windows clipboard transport can change LF record delimiters into CR-LF. The
receiver restores these delimiters only if the original sender checksum then
matches. JSON-escaped line breaks inside Label text retain their original value.
The saved JSON reports the normalization count in `transport`. Other checksum
failures remain rejected; their raw HUD packets are kept separately in
`hud_rejected_*.jsonl.part` for diagnosis. Unrelated clipboard text is not saved.
The receiver also accepts the previously compiled v3 sender, which still has
its old collection limit and starts transfer only after collection ends.

The game's **Sending finished** message confirms only that dispatch calls
returned. It cannot confirm receipt. Each batch is dispatched repeatedly, and
the receiver tolerates duplicates and reordering, checks per-batch checksums and
session identity, and requires a valid end record. The clipboard has no verified
acknowledgement channel, so repetitions cannot guarantee delivery. Missed batches
can still cause a timeout. Incomplete transfers remain journals and are not
published as captures.
Transport completeness does not imply complete native state: inspect metadata
for failed reads, skipped/destroyed panels and capture limits.

## Capture work and previous hangs

Collection uses an explicit traversal stack and bounded scheduled slices. Each
node is serialized independently; a ready batch pauses traversal until its
dispatch finishes, keeping the text queue bounded. The nested JSON is assembled
in Python after transfer. Receiving and reconstructing can take several minutes
for a large HUD; receiver progress starts while collection is still running.
There is no recursive whole-tree collection, exhaustive `BHasClass()` whitelist,
style enumeration, computed-layout sampling by default, hidden TextEntry, or
whole-tree `JSON.stringify()` in the client. One job owns one scheduled callback;
repeated presses while busy cannot start overlapping exports. Destruction,
errors and the job deadline abort and release owned buffers.

Earlier source history included writing a huge JSON string into a hidden
TextEntry; a subsequent edit removed that path. The recovered v2 source still
collected and serialized the tree synchronously, checked a large class whitelist,
and could unlock another capture before export ended. Those are verified source
defects. They do not establish the exact cause of a native client hang.

Scheduling bounds the amount of JavaScript work between yields; it cannot
interrupt a single slow or stuck native call. Client verification is still
required. Collection progress appears in the game console; transfer progress
appears in the receiver. A focused capture can optionally use a previously
verified subtree ID in `ROOT_ID`; it is not required to work around the old
character limit. Record the last console stage if a hang recurs. Optional
measurements and all capture limits live in the source.

The result spans a collection interval, so values can come from different
frames. `GetClasses-returned` is a legacy metadata value for a successful getter
in the collector or its test fixtures; it is not evidence that native Panorama
exposes that getter. Unavailable class reads and text truncation are explicit.
Styles are deliberately absent. An offline importer cannot infer missing native
state from this JSON, and class-dependent profiling is incomplete when class
reads are unavailable.

## Offline verification

```text
node --test HUD-Dumper/tests/hud_dumper.test.cjs
python -m unittest discover -s tools/tests -v
```

The tests cover full HUD streaming beyond the old cumulative size limit with
bounded text buffers, immediate disk journaling, destroyed panels, limits,
no style/whitelist probes, job ownership, Unicode
packet boundaries, JavaScript/Python interoperability, loss/duplicate/session
handling, and publication without overwriting captures. They do not prove native
rendering, API latency, clipboard delivery or absence of in-game freezes.
