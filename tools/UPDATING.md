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

After changes reach `main`, `mod-releases.yml` compares catalog mod asset hashes
with their last successful individual GitHub release. It includes every supported
content root, not only Panorama. `release_catalog.json` is the shared public-build
catalog: experimental folders are not published merely because they contain
Panorama sources. Mods without a verified GameBanana ID can have GitHub releases
but are not offered in the GameBanana dropdown. Add native overrides to
`upstream.json`; add a new public mod or verified GB submission to the release
catalog and update the workflow dropdown in the same change.

Each changed catalog mod has its own build job and immutable release tag
`mods/<mod>/<source-commit>`. The tag identifies source, not a new mod version.
The nickname submission includes both offset variants; Bridge Buff Reminder
includes all five existing alert variants. A release is created as a draft,
receives all ZIPs and `release.json` with archive sizes/checksums, and becomes
public only after successful compilation and packing. One failed mod does not
cancel other builds; failed publications remain eligible on the next push or
manual release-workflow run. Existing public releases are not replaced. Existing
legacy combined releases are left intact and are not treated as per-mod build
checkpoints. The first run builds the catalog because no such checkpoints exist.

`gamebanana-status.yml` checks successful releases after the release workflow and
hourly. It reports mods awaiting matching compiled releases or native fixes, and
notifies Discord of compiled mods needing GB publication. A notification receipt
is stored on that mod's release after acknowledged delivery, so unchanged pending
publications do not ping every hour. An initial missing GB checkpoint means the
release has not been published through this pipeline; it does not prove that all
older files on GameBanana are obsolete.

Run **Publish GameBanana update**, choose the submission in its dropdown and
preview the selected archives/version with the default dry run. Disable dry run
to publish after client verification. It uses the matching immutable GitHub
release, validates every archive checksum and supported variant, and rejects
pending native overrides and releases that no longer match `main`. Versions
increment the last numeric component (`1.9` becomes `1.10`; `1.0.9` becomes
`1.0.10`). Legacy dates or other nonnumeric versions migrate to `1.1`; the optional
`version` input can override that first value or select a larger numeric version.
Repository mod/schema versions are not changed by this workflow.

GB authentication and file upload/registration reuse its existing upload endpoint
and Edit form transport. They preserve the existing description, credits, AI
fields, images and license; the current form schema is checked before uploading.
The GB Add Update itself uses the JSON API route and fields from the site's
[UpsertUpdate component](https://webfiles.gamebanana.com/StrangeBerry/Components/UpsertUpdate.js),
with the API base used by its
[client helper](https://webfiles.gamebanana.com/StrangeBerry/Static/js/common.js).
It associates the uploaded files, sets the numeric update version and writes
`Updated to the game's latest update.` as its notes/changelog. Authenticated form
submission and Add Update still need verification in the first authorized run;
offline tests do not prove that private form/API contracts remain available.

Before uploading, the selected version is reserved on the release. Retries reuse
that reservation, inspect acknowledged uploaded files and look for the existing
update/version before creating another Add Update. Mutating GB requests are not
blindly retried. A version changed outside the reserved attempt blocks retry.
A partial or ambiguous failure remains unpublished in the queue;
inspect its GB state before overriding a reserved version. The successful
`gamebanana-published.json` checkpoint is recorded only after file/version and
Add Update acknowledgements. These checkpoints live as small GitHub release
assets; workflows do not commit build/publication bookkeeping into `main`.

### Repository setup

- Allow GitHub Actions to create pull requests in the repository's Actions
  workflow-permissions settings. The source workflow requests `contents: write`
  and `pull-requests: write` and runs its source tests before opening the PR.
- Set secret `DISCORD_UI_MODS_WEBHOOK_URL` and repository variables
  `DISCORD_UI_MODS_CHANNEL_ID` / `DISCORD_UI_MODS_ROLE_ID`. They are separate from
  QOLLOCK's configuration. Only that role can be mentioned; channel validation
  happens before sending. Notification failures leave proposals/publications
  unacknowledged and retryable without failing a successful source review.
- Keep the existing `CSDK_DRIVE_URL`, `GB_USERNAME` and `GB_PASSWORD` secrets.
  A separate GB API key is not assumed; its authenticated site API uses the
  existing account session. Do not place credentials or webhook URLs in source.

CI prepares PNG/TGA descriptors using the existing local builder's format,
compiles supported sound/image and XML/CSS/JS resources, and stages supported
precompiled resources/fonts. HTML/JSON/TXT do not become game assets automatically.
CI packs with pinned [ValvePython vpk 1.4.0](https://github.com/ValvePython/vpk),
uses unique content/game staging trees, and verifies package paths, checksums and
bytes against compiler output before publication. Source-only checks run with
`python tools/run_source_checks.py`; they do not invoke a compiler/packer or the
VPK filesystem tests. The maintainer performs compilation/repacking and client
verification; agents must not dispatch these publication workflows as a test.

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
