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

The updater reads committed upstream blobs and normalizes the Viewer's compiled
reference notation. XML uses three-way text merging plus structural checks for
native/mod edits, ambiguous anchors, moved/deleted nodes and changed mod insertion
contexts. Clean source merges still require client verification. Base CSS copies
are refreshed verbatim. CSS `extension` entries retain their local rules and
inherit updates through a verified, separately tracked native base import.
Changes to fully `owned` replacements require manual review; acknowledge a
reviewed file with `--revision <reviewed-commit> --accept-review <mod-path>`.

The default mode aborts the complete plan on conflicts, missing resources or
invalid XML. CI uses `--allow-partial`: an unresolved file blocks all source
writes and merge-base advancement for its mod, while independent mods proceed.
Pending reasons/revisions stay in the manifest and a source-only report under
`.upstream-review/`. Repeated runs cannot silently accept the unresolved base.
Build selection excludes blocked mods, including both topbar nickname variants
when either is blocked, and retains their last published hashes for retries.
Resolve against the current native resource and preserve the mod additions.
Register new native overrides explicitly.

The removed legacy `unit_status_overlay`/`unit_status_overlay_old` layouts and
`unit_status`/`unit_status_old` CSS are explicitly `retired` tracking entries.
Their source files remain for legacy compatibility. Retirement does not prove
C++ reachability or authorize deleting packed resources. They are no longer
requested as current native files; reappearance blocks the owning mod for review.
Current v2 resources remain tracked.

## Review and publication workflows

`auto-update.yml` checks all manifest entries on the existing dispatch events and
an hourly schedule. It generates source proposals and a report, then creates or
updates one `codex/native-resource-update` PR. It never pushes source changes to
`main`, compiles a mod, creates a release, uploads to GameBanana or merges its PR.
Manual dispatch defaults to a dry run. Native changes affecting only unrelated
resources do not advance merge bases or produce another proposal. Pending native
resources retain their identity across unrelated commits.

The PR body contains a resource/source fingerprint. An unchanged proposal reuses
its open PR and sends at most one acknowledged Discord notification. A closed or
merged proposal with the same fingerprint is not recreated. A new proposal
can refresh a bot-only branch, with an explicit lease; maintainer commits block
regeneration so manual fixes cannot be overwritten. An unresolved file keeps all
sources and merge bases of its mod unchanged while other mods proceed. Resolving
native conflicts remains a maintainer review task. No ZIP, before/after snapshots
or diff attachments are created for developer notifications.

Native review is source-only. Compilation/repacking and client verification
remain the maintainer's responsibility. The previous combined release and
automatic nickname upload steps are removed from this workflow.

### Repository setup

- Allow GitHub Actions to create pull requests in the repository's Actions
  workflow-permissions settings. The source workflow requests `contents: write`
  and `pull-requests: write` and runs its source tests before opening the PR.
- Set secret `DISCORD_UI_MODS_WEBHOOK_URL` and repository variables
  `DISCORD_UI_MODS_CHANNEL_ID` / `DISCORD_UI_MODS_ROLE_ID`. They are separate from
  QOLLOCK's configuration. Only that role can be mentioned; channel validation
  happens before sending. Notification failures leave proposals/publications
  unacknowledged and retryable without failing a successful source review.

Source-only regressions run with `python tools/run_source_checks.py`; they do not
invoke a native compiler/packer or the VPK filesystem tests.

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
node tools/tests/runtime_regressions.cjs
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
