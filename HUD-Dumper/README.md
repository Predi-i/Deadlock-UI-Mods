# HUD-Dumper

Standalone diagnostic source for capturing a live HUD tree. It records panel IDs,
types, classes returned by `GetClasses()`, basic flags, and `Label`/`TextEntry`
text. The Windows Python receiver rebuilds the nested `domTree` JSON used by the
QOLLOCK offline profiler. This is a structural capture, not an FPS measurement.

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
   starts; the clipboard is replaced by small packets throughout export.
4. Wait for the receiver's **Saved verified complete packet set** message. Its
   output path points to a new capture under `captures/`. Scenario labels can
   be changed with `--label match` or `--label hideout`; `--output-dir` selects
   another directory. Previous captures are never overwritten.
5. Inspect capture warnings before using it. Select this file explicitly in
   the profiler; the old `deadlock_hud_dump.json` is not replaced automatically.

The game's **Sending finished** message confirms only that dispatch calls
returned. It cannot confirm receipt. Export repeats the packet set, and the
receiver tolerates duplicates and reordering, checks per-packet checksums and
session identity, and requires the complete set plus a valid end record. Missed
packets can still cause a timeout. Incomplete transfers are not saved as captures.
Transport completeness does not imply complete native state: inspect metadata
for failed reads, skipped/destroyed panels and capture limits.

## Capture work and previous hangs

Collection uses an explicit traversal stack and bounded scheduled slices. Each
node is serialized independently; the nested JSON is assembled in Python.
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
appears in the receiver. For an initial smaller diagnostic, change `ROOT_ID` in
`panorama/scripts/hud_dumper.js` to the previously verified `hudActivePlayerStats`
subtree, then compile/repack again. Record the last console stage if a hang
recurs. Optional measurements and all capture limits live in the source.

The result spans a collection interval, so values can come from different
frames. `GetClasses-returned` describes the API's returned list; it does not
guarantee engine-internal class completeness. Text or class truncation and
unavailable reads are explicit. Styles are deliberately absent. An offline
importer cannot infer missing native state from this JSON.

## Offline verification

```text
node --test HUD-Dumper/tests/hud_dumper.test.cjs
python -m unittest discover -s tools/tests -v
```

The tests cover a tree matching the previous capture's panel count, bounded
work, destroyed panels, limits, no style/whitelist probes, job ownership, Unicode
packet boundaries, JavaScript/Python interoperability, loss/duplicate/session
handling, and publication without overwriting captures. They do not prove native
rendering, API latency, clipboard delivery or absence of in-game freezes.
