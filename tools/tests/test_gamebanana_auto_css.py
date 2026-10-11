import json
import pathlib
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import gamebanana_auto_css as auto
import gamebanana_queue as queue


class AutoCssPublicationTests(unittest.TestCase):
    def fixture(self):
        mod = 'Show-Nicknames-In-TopBar'
        record = {'mod': mod, 'commit': 'new', 'hashes': {'mod': 'new'}, 'tag': 'new', 'assets': [], 'url': 'https://example.invalid/new'}
        base = {'commit': 'old', 'receipt': {'version': '1.1', 'file_ids': [10, 11], 'update_id': 40}}
        return mod, record, base

    def test_unknown_gb_baseline_and_old_unpublished_xml_cannot_auto_publish(self):
        mod, record, base = self.fixture()
        with patch.object(auto, 'latest', return_value={mod: record}), patch.object(auto, 'hashes', return_value=record['hashes']), patch.object(auto, 'attested', return_value=True), patch.object(auto, 'download_record', return_value=None), patch.object(auto, 'published_baseline', return_value=None):
            task, reason = auto.eligibility('test/repo', mod, [], {'files': []})
            self.assertIsNone(task)
            self.assertIn('baseline unknown', reason)
        with patch.object(auto, 'latest', return_value={mod: record}), patch.object(auto, 'hashes', return_value=record['hashes']), patch.object(auto, 'attested', return_value=True), patch.object(auto, 'download_record', return_value=None), patch.object(auto, 'published_baseline', return_value=base), patch.object(auto, 'css_delta', return_value=(False, ['mod/panorama/layout/a.xml'])):
            task, reason = auto.eligibility('test/repo', mod, [], {'files': []})
            self.assertIsNone(task)
            self.assertIn('XML', reason)

    def test_css_only_publication_requires_unchanged_confirmed_baseline(self):
        mod, record, base = self.fixture()
        with patch.object(auto, 'latest', return_value={mod: record}), patch.object(auto, 'hashes', return_value=record['hashes']), patch.object(auto, 'attested', return_value=True), patch.object(auto, 'download_record', return_value=None), patch.object(auto, 'published_baseline', return_value=base), patch.object(auto, 'css_delta', return_value=(True, ['mod/panorama/styles/base/a.css'])):
            task, _ = auto.eligibility('test/repo', mod, [], {'files': []})
        self.assertEqual(task, {'mod': mod, 'publish': True, 'baseline': base['receipt']})

    def test_notification_retry_does_not_publish_again_and_pending_variant_blocks_pair(self):
        mod, record, _ = self.fixture()
        done = {'hashes': record['hashes'], 'update_id': 42, 'automatic_css': True}
        with patch.object(auto, 'latest', return_value={mod: record}), patch.object(auto, 'hashes', return_value=record['hashes']), patch.object(auto, 'attested', return_value=True), patch.object(auto, 'download_record', side_effect=[done, None]):
            task, _ = auto.eligibility('test/repo', mod, [], {'files': []})
            self.assertEqual(task, {'mod': mod, 'publish': False})
            task, reason = auto.eligibility('test/repo', mod, [], {'files': [{'path': 'Show-Nicknames-In-TopBar-No-Offsets/panorama/layout/a.xml', 'pending': {}}]})
            self.assertIsNone(task)
            self.assertIn('Unresolved', reason)

    def test_success_notice_requires_gb_ack_and_failed_delivery_is_retryable(self):
        mod, record, _ = self.fixture()
        done = {'hashes': record['hashes'], 'version': '1.1', 'file_ids': [100, 101], 'update_id': 42, 'automatic_css': True}
        with patch.object(queue, 'read_releases'), patch.object(queue, 'latest', return_value={mod: record}), patch.object(queue, 'download_record', return_value=None), patch.object(queue, 'send') as send:
            self.assertFalse(queue.notify_published('test/repo', mod))
            send.assert_not_called()
        with patch.object(queue, 'read_releases'), patch.object(queue, 'latest', return_value={mod: record}), patch.object(queue, 'download_record', side_effect=[done, None]), patch.object(queue, 'send', return_value=False), patch.object(queue, 'store_record') as store:
            self.assertFalse(queue.notify_published('test/repo', mod))
            store.assert_not_called()
        with patch.object(queue, 'read_releases'), patch.object(queue, 'latest', return_value={mod: record}), patch.object(queue, 'download_record', side_effect=[done, None]), patch.object(queue, 'send', return_value=True) as send, patch.object(queue, 'store_record') as store:
            self.assertTrue(queue.notify_published('test/repo', mod))
            self.assertIn('All 2 supported archive(s)', send.call_args.args[0])
            self.assertIn('https://gamebanana.com/updates/42', send.call_args.args[0])
            self.assertEqual(store.call_args.args[3]['update_id'], 42)


if __name__ == '__main__':
    unittest.main()
