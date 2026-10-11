import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import update_mods as updater
import prepare_native_review as prs
import notify_mod_updates as discord


class NativeWorkflowTests(unittest.TestCase):
    def test_unrelated_native_commit_does_not_advance_bases_or_open_review(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            game = root / "game"
            game.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(game), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Predi-i")
            git("config", "user.email", "Predi-i@users.noreply.github.com")
            (game / "native.xml").write_text('<root><Panel id="native" /></root>')
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            target = root / "mod/native.xml"
            target.parent.mkdir()
            target.write_text('<root><Panel id="native" /><Panel id="mod" /></root>')
            manifest = {"files": [{"path": "mod/native.xml", "upstream": "native.xml", "base": base, "mode": "merge"}]}
            original = copy.deepcopy(manifest)
            (game / "irrelevant.txt").write_text("unrelated")
            git("add", ".")
            git("commit", "-qm", "unrelated")
            revision = git("rev-parse", "HEAD")
            changes = []
            with patch.object(updater, "ROOT", root):
                self.assertEqual(updater.plan(game, manifest, revision, changes=changes), {})
            self.assertEqual(manifest, original)
            summary = updater.review(manifest, revision, root / "report", changes)
            self.assertFalse(summary["changed"])

    def test_repeated_blocked_resource_keeps_notification_identity_across_unrelated_commits(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / "mod").mkdir()
            (root / "mod/legacy.xml").write_text('<root />')
            manifest = {"files": [{"path": "mod/legacy.xml", "upstream": "native.xml", "base": "base", "mode": "retired"}]}
            response = MagicMock(returncode=0, stdout=b'<root />')
            with patch.object(updater, "ROOT", root), patch.object(updater.subprocess, "run", return_value=response):
                changes = []
                updater.plan(root, manifest, "first", allow_partial=True, changes=changes)
                first = updater.review(manifest, "first", root / "report", changes)
                again = []
                updater.plan(root, manifest, "second", allow_partial=True, changes=again)
                second = updater.review(manifest, "second", root / "report", again)
            self.assertEqual(first["fingerprint"], second["fingerprint"])
            self.assertEqual(manifest["files"][0]["pending"]["revision"], "first")

    def test_dry_run_cannot_push_or_create_pr(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            (path / "summary.json").write_text(json.dumps({"changed": True, "fingerprint": "a" * 64}))
            with patch.object(prs, "command") as command:
                result = prs.prepare(path, "main", dry_run=True)
            command.assert_not_called()
            self.assertFalse(result["pr_url"])

    def test_existing_review_is_reused_and_acknowledged_without_branch_mutations(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            fingerprint = "a" * 64
            url = "https://github.com/Predi-i/Deadlock-UI-Mods/pull/1"
            (path / "summary.json").write_text(json.dumps({"changed": True, "fingerprint": fingerprint}))
            response = MagicMock(stdout=json.dumps([{"url": url, "body": f"<!-- native-review:{fingerprint} -->\n<!-- notified:{fingerprint} -->"}]))
            with patch.object(prs, "command", return_value=response) as command:
                result = prs.prepare(path, "main")
            self.assertEqual(command.call_count, 1)
            self.assertEqual(result["pr_url"], url)
            self.assertTrue(result["notified"])

    def test_maintainer_commit_prevents_review_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            (path / "summary.json").write_text(json.dumps({"changed": True, "fingerprint": "a" * 64}))
            responses = [MagicMock(stdout="[]"), MagicMock(), MagicMock(returncode=0, stdout="commit"), MagicMock(stdout="maintainer XML fix\n")]
            with patch.object(prs, "command", side_effect=responses) as command:
                with self.assertRaisesRegex(RuntimeError, "maintainer commits"):
                    prs.prepare(path, "main")
            self.assertFalse(any(call.args[0:2] == ("git", "push") for call in command.call_args_list))

    def test_closed_unchanged_review_is_not_recreated(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            fingerprint = 'a' * 64
            (path / 'summary.json').write_text(json.dumps({'changed': True, 'fingerprint': fingerprint}))
            response = MagicMock(stdout=json.dumps([{'url': 'closed', 'body': f'<!-- native-review:{fingerprint} -->', 'state': 'CLOSED'}]))
            with patch.object(prs, 'command', return_value=response) as command:
                result = prs.prepare(path, 'main')
            self.assertFalse(result['pr_url'])
            self.assertEqual(command.call_count, 1)

    def test_amended_bot_subject_cannot_hide_maintainer_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            (path / 'summary.json').write_text(json.dumps({'changed': True, 'fingerprint': 'a' * 64}))
            reviews = [{'url': 'review', 'body': '<!-- native-commit:' + 'b' * 40 + ' -->', 'state': 'OPEN'}]
            responses = [MagicMock(stdout=json.dumps(reviews)), MagicMock(), MagicMock(returncode=0, stdout='c' * 40), MagicMock(stdout=prs.SUBJECT + '\n')]
            with patch.object(prs, 'command', side_effect=responses) as command:
                with self.assertRaisesRegex(RuntimeError, 'amended maintainer fixes'):
                    prs.prepare(path, 'main')
            self.assertFalse(any(call.args[0:2] == ('git', 'push') for call in command.call_args_list))

    def test_webhook_uses_only_configured_role_and_does_not_send_to_wrong_channel(self):
        config = {"DISCORD_WEBHOOK_URL": "https://discord.com/api/webhooks/1/private", "DISCORD_CHANNEL_ID": "123456789012345678", "DISCORD_ROLE_ID": "234567890123456789"}
        with patch.dict(discord.os.environ, config), patch.object(discord, "request_json", side_effect=[{"channel_id": config["DISCORD_CHANNEL_ID"]}, {"channel_id": config["DISCORD_CHANNEL_ID"], "id": "ack"}]) as request:
            self.assertTrue(discord.send("PR link"))
            payload = request.call_args_list[1].args[1]
            self.assertEqual(set(payload), {"content", "allowed_mentions"})
            self.assertEqual(payload["allowed_mentions"], {"parse": [], "roles": [config["DISCORD_ROLE_ID"]]})
        with patch.dict(discord.os.environ, config), patch.object(discord, "request_json", return_value={"channel_id": "wrong"}) as request:
            with self.assertRaisesRegex(ValueError, "configured UI Mods channel"):
                discord.send("PR link")
            self.assertEqual(request.call_count, 1)


if __name__ == "__main__":
    unittest.main()
