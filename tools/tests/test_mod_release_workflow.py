import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import mod_releases as releases
import gamebanana_queue as queue
import gamebanana_api as api


def release_record(mod, hashes, draft=False):
    metadata = {"mod": mod, "commit": "a" * 40, "hashes": hashes}
    return {"body": '<!-- mod-release:' + json.dumps(metadata) + ' -->', "tag_name": "mods/test/commit",
            "html_url": "https://github.com/test/repo/releases/tag/test", "assets": [], "draft": draft,
            "prerelease": False, "published_at": "2026-10-11T00:00:00Z"}


class ReleaseWorkflowTests(unittest.TestCase):
    def test_hash_covers_non_panorama_assets_and_ignores_line_ending_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            source = root / "mod/soundevents"
            source.mkdir(parents=True)
            file = source / "event.txt"
            file.write_bytes(b"same\r\n")
            initial = releases.asset_hash("mod", root)
            file.write_bytes(b"same\n")
            self.assertEqual(initial, releases.asset_hash("mod", root))
            file.write_bytes(b"new\n")
            self.assertNotEqual(initial, releases.asset_hash("mod", root))

    def test_drafts_and_legacy_combined_releases_cannot_acknowledge_a_build(self):
        mod = "Parry-Cooldown"
        current = {mod: "hash"}
        self.assertEqual(releases.latest([release_record(mod, current, draft=True)]), {})
        legacy = release_record(mod, current)
        legacy["body"] = "Deadlock UI Mods v142"
        self.assertEqual(releases.latest([legacy]), {})

    def test_planner_and_builder_use_same_case_order_and_source2_line_endings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            paths = ['panorama/images/Z.png', 'panorama/images/a.png', 'panorama/images/z.vtex', 'soundevents/event.vsndevts']
            for name in paths:
                file = root / 'mod' / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'binary\x00\r\n' if file.suffix == '.png' else b'text\r\n')
            expected = hashlib.sha256()
            for name in sorted(paths, key=lambda value: tuple(part.casefold() for part in value.split('/'))):
                expected.update(name.encode() + b'\0')
                expected.update((b'binary\x00\r\n' if name.endswith('.png') else b'text\n') + b'\0')
            initial = releases.asset_hash('mod', root)
            self.assertEqual(initial, expected.hexdigest())
            for name in paths:
                if not name.endswith('.png'):
                    (root / 'mod' / name).write_bytes(b'text\n')
            self.assertEqual(initial, releases.asset_hash('mod', root))

    def test_blocked_variant_excludes_whole_release_while_other_mod_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "tools").mkdir()
            (root / "tools/upstream.json").write_text(json.dumps({"files": [{"path": "Show-Nicknames-In-TopBar-No-Offsets/panorama/layout/a.xml", "pending": {}}]}))
            catalog = {key: releases.CATALOG[key] for key in ("Parry-Cooldown", "Show-Nicknames-In-TopBar")}
            with patch.object(releases, "ROOT", root), patch.object(releases, "CATALOG", catalog), patch.object(releases, "hashes", side_effect=lambda mod: {mod: "new"}):
                result = releases.selection([], "a" * 40)
                self.assertEqual([item["mod"] for item in result], ["Parry-Cooldown"])
                successful = release_record("Parry-Cooldown", {"Parry-Cooldown": "new"})
                self.assertEqual(releases.selection([successful], "b" * 40), [])

    def test_publication_queue_requires_matching_release_and_successful_api_receipt(self):
        mod = "Parry-Cooldown"
        current = {mod: "hash"}
        record = release_record(mod, current)
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "tools").mkdir()
            (root / "tools/upstream.json").write_text('{"files": []}')
            with patch.object(queue, "ROOT", root), patch.dict(queue.CATALOG, {mod: queue.CATALOG[mod]}, clear=True), patch.object(queue, "hashes", return_value=current), patch.object(queue, "download_record", return_value=None):
                self.assertEqual(len(queue.pending("test/repo", [record])["ready"]), 1)
                with patch.object(queue, "download_record", return_value={"hashes": current, "update_id": 42}):
                    self.assertEqual(queue.pending("test/repo", [record])["ready"], [])
                with patch.object(queue, "hashes", return_value={mod: "newer"}):
                    self.assertEqual(queue.pending("test/repo", [record])["ready"], [])
                    self.assertTrue(queue.pending("test/repo", [record])["waiting"])

    def test_missing_discord_acknowledgement_does_not_clear_publication_notice(self):
        pending = {"ready": [{"mod": "Parry-Cooldown", "url": "https://example.invalid/release", "tag": "tag", "hashes": {}, "notified": False}]}
        with patch.object(queue, "send", return_value=False), patch.object(queue, "store_record") as store:
            queue.notify("test/repo", pending)
            store.assert_not_called()

    def test_existing_tag_with_different_metadata_is_preserved_even_if_draft(self):
        record = {'mod': 'Parry-Cooldown', 'commit': 'a' * 40, 'hashes': {'Parry-Cooldown': 'hash'}}
        for draft in (True, False):
            with self.subTest(draft=draft), patch.object(releases, 'read_releases', return_value=[]), patch.object(releases, 'ensure_tag'), patch.object(releases, 'write_manifest', return_value=record), patch.object(releases.subprocess, 'run', return_value=MagicMock(returncode=0)), patch.object(releases, 'gh', return_value=json.dumps({'isDraft': draft, 'body': 'An unrelated release'})) as command:
                with self.assertRaisesRegex(ValueError, 'different release metadata'):
                    releases.publish(record['mod'], record['commit'], pathlib.Path('unused'), 'test/repo')
                self.assertEqual(command.call_count, 1)

    def test_overlapping_plan_rechecks_successful_hash_before_creating_any_release(self):
        mod = 'Parry-Cooldown'
        with patch.object(releases, 'read_releases', return_value=[release_record(mod, {mod: 'hash'})]), patch.object(releases, 'hashes', return_value={mod: 'hash'}), patch.object(releases, 'write_manifest') as manifest, patch.object(releases, 'ensure_tag') as tag:
            releases.publish(mod, 'b' * 40, pathlib.Path('unused'), 'test/repo')
        manifest.assert_not_called()
        tag.assert_not_called()

    def test_source_tag_is_reserved_and_existing_target_cannot_be_changed(self):
        commit = 'a' * 40
        with patch.object(releases, 'gh', side_effect=[RuntimeError('Not Found (HTTP 404)'), '{}']) as command:
            releases.ensure_tag('test/repo', 'mods/fixture/' + commit, commit)
        self.assertIn('sha=' + commit, command.call_args.args)
        self.assertIn('ref=refs/tags/mods/fixture/' + commit, command.call_args.args)
        with patch.object(releases, 'gh', return_value=json.dumps({'object': {'type': 'commit', 'sha': 'b' * 40}})) as command:
            with self.assertRaisesRegex(ValueError, 'different source'):
                releases.ensure_tag('test/repo', 'mods/fixture/' + commit, commit)
            command.assert_called_once()

    def test_tag_create_lost_response_reconciles_existing_target_without_another_post(self):
        commit = 'a' * 40
        with patch.object(releases, 'gh', side_effect=[RuntimeError('Not Found (HTTP 404)'), RuntimeError('connection lost'), json.dumps({'object': {'type': 'commit', 'sha': commit}})]) as command:
            releases.ensure_tag('test/repo', 'mods/fixture/' + commit, commit)
        self.assertEqual(command.call_count, 3)
        self.assertEqual(sum('--method' in call.args for call in command.call_args_list), 1)

    def test_release_creation_uses_verified_tag_without_old_workflow_commit_target(self):
        record = {'mod': 'Parry-Cooldown', 'commit': 'a' * 40, 'hashes': {'Parry-Cooldown': 'hash'}, 'files': [{'name': 'fixture.zip'}]}
        with patch.object(releases, 'read_releases', return_value=[]), patch.object(releases, 'write_manifest', return_value=record), patch.object(releases, 'ensure_tag') as tag, patch.object(releases.subprocess, 'run', return_value=MagicMock(returncode=1)), patch.object(releases, 'gh') as command:
            releases.publish(record['mod'], record['commit'], pathlib.Path('unused'), 'test/repo')
        tag.assert_called_once()
        create = command.call_args_list[0].args
        self.assertIn('--verify-tag', create)
        self.assertNotIn('--target', create)

    def test_downloaded_archive_must_match_release_and_supported_variants(self):
        mod = "Show-Nicknames-In-TopBar"
        release = {"mod": mod, "commit": "commit", "hashes": {name: "hash" for name in releases.CATALOG[mod]["sources"]}}
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            records = []
            for source in releases.CATALOG[mod]["sources"]:
                path = root / (source + '.zip')
                path.write_bytes(b'archive fixture')
                records.append({"name": path.name, "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            (root / 'release.json').write_text(json.dumps({**release, "files": records}))
            self.assertEqual(len(api.verify_archives(mod, release, root)), 2)
            (root / records[0]['name']).write_bytes(b'tampered')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                api.verify_archives(mod, release, root)
            (root / 'release.json').write_text(json.dumps({**release, "files": records[:1]}))
            with self.assertRaisesRegex(ValueError, 'variant'):
                api.verify_archives(mod, release, root)


if __name__ == '__main__':
    unittest.main()
