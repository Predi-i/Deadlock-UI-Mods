# Native resource updates and captured HUD lookups

`upstream.json` lists native resources overridden by the mods and the exact
GameTracking revision used as their merge base. It covers shared native layouts,
vendored base styles, and fully owned CSS replacements. Mod-only resources have
no upstream counterpart and do not belong in this manifest.

```text
python tools/update_mods.py --game-root <GameTracking-checkout> --check
python tools/update_mods.py --game-root <GameTracking-checkout>
python tools/sync_hud_lookup.py
```

The updater reads committed upstream blobs, normalizes the Viewer's compiled
reference notation, and uses three-way merging for native overrides. Base CSS
copies are refreshed verbatim. An upstream change to a fully owned replacement
requires manual compatibility review. Overlapping edits, missing upstream files
and invalid XML abort the plan before any file is written. Resolve against the
current native resource, preserve the mod additions, and advance that file's
`base` to the reviewed upstream commit. Register new native overrides explicitly.

The Mod Updater workflow performs source synchronization for all registered mods.
Build selection uses hashes of each mod's Panorama assets compared with the last
successful publication. A failed build or upload remains eligible for retry even
if the source updater has already committed its changes. Manual dispatch builds
every mod. GitHub Releases contain the selected mod archives; GameBanana upload
continues to target only the nickname mod's existing submission and paired variants.
The first run without a recorded build state builds every mod.

CI prepares PNG/TGA descriptors using the existing local builder's descriptor
format, compiles sound and image resources as well as XML/CSS/JS, and copies raw
HTML assets. Compiler and packer failures abort publication. Source tests do not
prove that the CSDK can compile every asset; the maintainer runs packaging/client
verification before relying on a release. CI itself is not dispatched by these
offline checks.

The GameBanana edit form now requires an AI Usage matrix. The uploader derives
names and values from its live columns/rows, using the maintainer's choice of
Minor for Code and None for the other areas. It validates that matrix before
uploading archives. Matrix parsing is tested offline; authenticated form submission
still needs verification in the next authorized CI run. If the form structure
changes, it fails with a specific diagnostic instead of guessing field hashes.

## HUD lookup maintenance

`hud_lookup.js` is the canonical source for standalone mod copies. Change it here
and run `sync_hud_lookup.py`; every mod packages its own copy. Routes come from
native XML and the maintainer's complete October 1 Panorama Debugger tree.
They descend through direct children, with small scoped traversals only where
anonymous native wrappers have no stable ID. Missing scopes never fall back to
searching the whole HUD. Valid panel handles are cached and replaced after deletion.
The BuffModifiers route deliberately retains the first native center-modifier
branch selected by the previous whole-HUD depth-first lookup.

```text
python -m unittest discover -s tools/tests -v
node tools/audit_hud_lookups.cjs <full-capture.json> [baseline-git-ref]
```

The capture audit verifies the target identity of each optimized route against
the captured depth-first lookup, including duplicate IDs, and exercises Active
Stats with native value-label fixtures. It also checks cache replacement, class-
and event-driven scoreboard transitions, and reload cleanup. Its equivalent
unscoped benchmark is a stress comparison of the same lookups, not the previous
mods' actual per-frame workload. An optional baseline ref runs the old Active
Stats script separately. Counts describe the model's traversal work, not FPS,
native CPU time, valid healthbar rendering, or panels absent from another state.
