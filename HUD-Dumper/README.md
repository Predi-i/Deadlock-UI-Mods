# HUD-Dumper

Standalone diagnostic source for streaming a live HUD tree. It records panel IDs,
types, basic flags, and `Label`/`TextEntry` text. The direct HUD collector cannot
enumerate native classes: the current client capture found `GetClasses()` unavailable
on every panel. Native Debugger row descriptions have now supplied real class
lists in a client probe; the experimental exporter below uses this source.
Full HUD coverage and description freshness still require client verification.
The Windows Python receiver rebuilds the nested `domTree` JSON used by the
QOLLOCK offline profiler. This is a structural capture, not an FPS measurement.

See [class enumeration investigation](CLASS_ENUMERATION.md) for the evidence and
the remaining requirement. A complete packet set must not be presented as a
complete capture of classes.

## Experimental native debugger export

The `debuglayout.xml` override retains the native core inspector layout and adds
`hud_dump_core.js` and `hud_debugger_export.js` in its own script context. The
previous bounded probe successfully read native `DebugLayoutPanelOpen` Labels
in the client, including classes assigned by the game. Its source is retained
but is no longer included by default. The exporter reads opening and closing
descriptions from direct row children instead of scanning every performance-bar
widget in the inspector.
It does not call internal C++ functions or require the debugger's JS console.

After maintainer compilation/repacking:

1. Start the same Python receiver with `--label debugger-hero-testing` before
   opening the debugger. Do not also start an M-key HUD capture during this export.
2. Open Panorama Debugger on the HUD tree whose root is `CitadelHudRoot`. Keep the
   inspector open and its target and expansion state unchanged during collection.
   The inspector can still include other window roots; the receiver retains that
   forest and selects the unique `CitadelHudRoot` as the profiler's `domTree`.
3. Look for `[HUD-DEBUGGER-EXPORT] LOADED`, then `BEGIN` after the startup delay.
   The script discovers `ShowChildren` rows using the native resource contract
   and activates collapsed `DebugLabelToggle` controls one per scheduled step.
   It checks that the same toggle actually expanded before continuing. The first
   successful operation logs `ACTIVATION VERIFIED` with before/after row counts.
   An ineffective event, unexpected row structure, destroyed context or row
   replacement aborts without sending a completion marker.
4. Raw descriptions stream through the existing repeated/checksummed v4 batches.
   Python journals them and saves a new JSON only after verifying every batch.
   The game then restores the toggles it expanded, in reverse order. Wait for
   `Cleanup finished` before closing the inspector. Reload/destruction can
   interrupt cleanup; reopen the debugger to reset expansion state in that case.
5. Inspect `meta.treeValid`, `remainingCollapsed`, `unrepresentedBranches` and
   `descriptionParseErrors`. Attach the capture and game console output for the
   first native verification. `fullHudCapture` remains false until native HUD
   coverage and description freshness are established independently.

The `debugger-rows-v1` payload records exact raw Label descriptions and expansion
flags. Python reconstructs parents from opening/closing descriptions, never
debugger UI depth or row visibility. The native description is not XML: values
are unescaped, and the verified final `text` field can contain quotes, `<`, `>`
and `&`. Its literal content, including entity-like strings, is preserved.
Other attributes are parsed strictly; unsupported descriptions retain explicit
errors rather than repaired or guessed parentage.

The native inspector can describe multiple independent window roots. They are
preserved in `domForest` without an invented common parent. The unique
`CitadelHudRoot` is selected as `domTree`; `summary` and the `unique*` lists describe
that selected subtree. `debuggerSummary` and `debuggerUniqueClasses` describe the
entire inspector export. A single-root export is also supported. Multiple roots
without a unique HUD root leave `domTree` null. `forestValid` and `treeValid`
distinguish these results. Every raw row is retained even when descriptions are
unbalanced; in that case neither tree representation is published.
The debugger's visibility
flag is recorded separately and never substituted for target HUD visibility.
Missing text attributes on Label/TextEntry descriptions are explicit. No XML
class whitelist is used. Successful parsing of a displayed class list means
`Debugger-rendered`, not a verified freshly sampled HUD state.

The first client export completed with 593 verified batches, 29,526 rows,
20,275 panels across 89 native roots, and 9,242 automatically expanded branches.
The HUD subtree reconstructed from those same packets contains 15,435 panels
and 1,331 distinct displayed classes. No collapsed or unrepresented branches
or description parse failures remain in that export. Its collection/transfer
interval was about nine minutes; freshness and independent live HUD coverage
remain unverified. Receiver repair/reconstruction does not require another
compile/repack or another game capture. Automatic restoration still needs its
client console result to be checked separately.

Native expansion creates actual debugger UI widgets and can be costly
for large trees; scheduling cannot interrupt one expensive native operation.
Collapsing after export restores the UI state, but does not prove those widgets
are freed. The script does not promise FPS, capture speed or freedom from native
hangs. The override remains registered for upstream merging.

## Completed HUD API investigation

The retained `hud_api_probe.js` prints lines prefixed `[HUD-API-PROBE]` to the game
console after a startup delay when included in a layout. The native tests have
completed and this script is no longer included in `base_hud.xml` by default.

The probe inspects property names and descriptors across prototype chains of the
HUD context, its direct `Hud` child when present, a small sample of direct HUD
children, and `$`. It prints descriptors without evaluating unknown getters or
calling discovered methods. Known methods are reported separately as a baseline.
Reflection errors and limits are reported; output is spread across scheduled
callbacks, and script reload cancels the previous probe. This discovers exposed
API names, not class membership, and does not traverse the whole HUD. Native
objects may expose fewer names through reflection than through direct lookup;
absence from this report alone is not proof of absence from the engine.

The `CLASS-ATTRIBUTE` experiment creates one temporary hidden panel, assigns two
test classes, then removes one. Each stage records `GetAttributeString("class",
...)` alongside membership checks for the deliberately assigned test classes.
It requests deletion of the owned panel even if a read fails. Existing HUD panels
are not modified. This tests whether the attribute getter tracks live class
changes; membership checks in this experiment are not a capture whitelist.

The confirmed native outcomes are recorded in [CLASS_ENUMERATION.md](CLASS_ENUMERATION.md).
Diagnostic limits and timing remain in the source.

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
