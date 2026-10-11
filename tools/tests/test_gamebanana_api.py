import html
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import gamebanana_api as api


class GameBananaApiTests(unittest.TestCase):
    def dynamic_form(self, archive_value='1'):
        records = [
            {'_idFileRow': '1836888', '_sVersion': '1.4', '_sDescription': 'Current "file"', '_bIsArchived': False},
            {'_idFileRow': '1769992', '_sVersion': '1.3', '_sDescription': 'Historical file', '_bIsArchived': True},
            {'_sTicketId': 'fixture-image', '_sCaption': 'Original "caption"'},
        ]
        template = ('<input name="_sDescription"><input name="_sVersion">'
                    '<input name="_bIsArchived" type="checkbox" value="' + archive_value + '">'
                    '<input name="_idFileRow" type="hidden"><input name="_sUploadReceiptId" type="hidden">')
        return ('<form><section id="Version"><input name="version" value="1.4"></section>'
                '<input name="files" value=""><input name="images" value="[]"></form>'
                '<script>var template = \'' + template + '\';' +
                ''.join('var file = ' + json.dumps(record) + ';' for record in records) + '</script>')

    def test_dynamic_form_restores_all_files_archive_flags_and_image_captions(self):
        publisher = api.Publisher('fixture', 'fixture', 670840)
        values = dict(publisher._preserved_form_fields(self.dynamic_form(), 'files', 'images'))
        files = [dict((field['name'], field['value']) for field in entry) for entry in json.loads(values['files'])]
        self.assertEqual([entry['_idFileRow'] for entry in files], ['1836888', '1769992'])
        self.assertNotIn('_bIsArchived', files[0])
        self.assertEqual(files[1]['_bIsArchived'], '1')
        self.assertEqual(files[0]['_sDescription'], 'Current "file"')
        self.assertEqual(files[1]['_sVersion'], '1.3')
        self.assertEqual(files[0]['_sUploadReceiptId'], 'undefined')
        self.assertEqual(json.loads(values['images']), [{'name': '_sCaption', 'value': 'Original "caption"'}, {'name': '_sTicketId', 'value': 'fixture-image'}])

    def test_changed_dynamic_archive_control_aborts_instead_of_unarchiving_history(self):
        publisher = api.Publisher('fixture', 'fixture', 670840)
        with self.assertRaisesRegex(RuntimeError, 'archive control changed'):
            publisher._preserved_form_fields(self.dynamic_form(archive_value='2'), 'files', 'images')

    def test_real_post_preserves_dynamic_files_and_images_before_appending_new_archive(self):
        publisher = api.Publisher('fixture', 'fixture', 670840)
        response = MagicMock(url='https://gamebanana.com/mods/670840', history=[], headers={}, text='ok', status_code=200)
        with patch.object(publisher, '_get_edit_page', return_value=self.dynamic_form()), patch.object(publisher, '_find_ownership_fields', return_value=[]), patch.object(publisher, '_request', return_value=response) as request:
            publisher.post_edit([{'file_row_id': 100, 'upload_receipt_id': 'fixture'}], '1.5', 'files', 'images', preserve_metadata=True)
        data = dict(request.call_args.kwargs['data'])
        files = [dict((field['name'], field['value']) for field in entry) for entry in json.loads(data['files'])]
        self.assertEqual([entry['_idFileRow'] for entry in files], ['1836888', '1769992', '100'])
        self.assertEqual(files[1]['_bIsArchived'], '1')
        self.assertEqual(files[2]['_sVersion'], '1.5')
        self.assertEqual(json.loads(data['images'])[0]['value'], 'Original "caption"')

    def test_authenticated_preview_cannot_upload_edit_reserve_or_add_update(self):
        mod = 'Commend-Everyone-Button'
        release = {'tag': 'fixture', 'hashes': {'fixture': 'hash'}}
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            (root / 'tools').mkdir()
            (root / 'tools/upstream.json').write_text('{"files": []}', encoding='utf-8')
            with patch.object(api, 'ROOT', root), patch.object(api, 'read_releases'), patch.object(api, 'latest', return_value={mod: release}), patch.object(api, 'hashes', return_value=release['hashes']), patch.object(api, 'download_record', return_value=None), patch.object(api, 'gh'), patch.object(api, 'verify_archives'), patch.object(api, 'store_record') as store, patch.object(api, 'Publisher') as factory:
                publisher = factory.return_value
                publisher.metadata.return_value = {'_sVersion': '1.4'}
                publisher.api.return_value = {'_aAccess': {'Update_Add': True}}
                api.publish('fixture/repo', mod, dry_run=True)
        publisher.authenticate.assert_called_once()
        publisher.verify_edit_form.assert_called_once()
        publisher.register_files.assert_not_called()
        publisher.upload_zip.assert_not_called()
        publisher.post_edit.assert_not_called()
        publisher.add_update.assert_not_called()
        store.assert_not_called()

    def test_numeric_versions_increment_without_floats_and_legacy_dates_migrate(self):
        self.assertEqual(api.next_version('1.9'), '1.10')
        self.assertEqual(api.next_version('1.0.9'), '1.0.10')
        self.assertEqual(api.next_version('2026.10.04'), '1.1')
        self.assertEqual(api.next_version('2026.10.04', '2.0'), '2.0')
        with self.assertRaisesRegex(ValueError, 'greater'):
            api.next_version('1.5', '1.4')

    def test_update_uses_confirmed_json_api_route_and_uploaded_file_ids(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        with patch.object(publisher, 'find_update', return_value=None), patch.object(publisher, 'api', return_value={'_idRow': 42}) as request:
            self.assertEqual(publisher.add_update('1.1', [100, 101]), 42)
        route, method, payload = request.call_args.args
        self.assertEqual(route, 'Mod/656390/Update')
        self.assertEqual(method, 'POST')
        self.assertEqual(payload['_sVersion'], '1.1')
        self.assertEqual(payload['_sText'], "Updated to the game's latest update.")
        self.assertEqual(payload['_aFileRowIds'], [100, 101])
        self.assertTrue(request.call_args.kwargs['update'])

    def test_retry_reuses_matching_update_and_refuses_ambiguous_version(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        existing = {'_aRecords': [{'_idRow': 42, '_sVersion': '1.1', '_aFiles': [{'_idRow': 100}, {'_idRow': 101}]}], '_aMetadata': {'_bIsComplete': True}}
        with patch.object(publisher, 'api', return_value=existing) as request:
            self.assertEqual(publisher.add_update('1.1', [100, 101]), 42)
            self.assertEqual(request.call_count, 1)
            with self.assertRaisesRegex(RuntimeError, 'different update'):
                publisher.add_update('1.1', [200])

    def test_missing_api_acknowledgement_cannot_be_reported_as_publication_success(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        with patch.object(publisher, 'find_update', return_value=None), patch.object(publisher, 'api', return_value={}), patch.object(api.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'did not acknowledge'):
                publisher.add_update('1.1', [100])

    def test_success_message_is_resolved_to_existing_record_without_another_post(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        with patch.object(publisher, 'find_update', side_effect=[None, None, 42]), patch.object(publisher, 'api', return_value={'_sSuccessCode': 'Success'}) as request, patch.object(api.time, 'sleep') as sleep:
            self.assertEqual(publisher.add_update('1.1', [100]), 42)
            self.assertEqual(request.call_count, 1)
            sleep.assert_called_once_with(10)

    def test_add_update_intent_is_saved_before_post_and_receipt_failure_prevents_post(self):
        publisher = MagicMock()
        events = []
        publisher.add_update.side_effect = lambda *args: events.append('POST') or 42
        reservation = {'hashes': {'fixture': 'hash'}, 'version': '1.1', 'previous_version': '1.0'}
        with patch.object(api, 'store_record', side_effect=lambda *args: events.append('intent')) as store:
            self.assertEqual(api.finish_update(publisher, 'fixture/repo', {'tag': 'fixture'}, reservation, '1.1', [100]), 42)
        self.assertEqual(events, ['intent', 'POST'])
        self.assertEqual(store.call_args.args[3], {**reservation, 'add_update_started': True, 'file_ids': [100]})
        publisher.add_update.reset_mock()
        with patch.object(api, 'store_record', side_effect=RuntimeError('receipt unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'receipt unavailable'):
                api.finish_update(publisher, 'fixture/repo', {'tag': 'fixture'}, reservation, '1.1', [100])
        publisher.add_update.assert_not_called()

    def test_retry_of_unknown_post_outcome_only_reads_existing_update(self):
        publisher = MagicMock()
        publisher.wait_update.return_value = 42
        reservation = {'add_update_started': True, 'file_ids': [100]}
        with patch.object(api, 'store_record') as store:
            self.assertEqual(api.finish_update(publisher, 'fixture/repo', {'tag': 'fixture'}, reservation, '1.1', [100]), 42)
            store.assert_not_called()
        publisher.wait_update.assert_called_once_with('1.1', [100])
        publisher.add_update.assert_not_called()
        publisher.wait_update.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'reconcile'):
            api.finish_update(publisher, 'fixture/repo', {'tag': 'fixture'}, reservation, '1.1', [100])
        publisher.add_update.assert_not_called()

    def test_changed_files_after_update_attempt_abort_before_read_or_post(self):
        publisher = MagicMock()
        with self.assertRaisesRegex(RuntimeError, 'files changed'):
            api.finish_update(publisher, 'fixture/repo', {'tag': 'fixture'}, {'add_update_started': True, 'file_ids': [100]}, '1.1', [101])
        publisher.wait_update.assert_not_called()
        publisher.add_update.assert_not_called()

    def test_update_retry_cannot_reupload_files_if_read_api_has_not_settled(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        with patch.object(publisher, 'attached_files', return_value=None), patch.object(publisher, 'metadata') as metadata, patch.object(publisher, 'upload_zip') as upload:
            with self.assertRaisesRegex(RuntimeError, 'reconcile before uploading'):
                publisher.register_files([pathlib.Path('fixture.zip')], '1.1', allow_upload=False)
        metadata.assert_not_called()
        upload.assert_not_called()

    def test_file_registration_waits_for_cache_without_another_upload_or_edit(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        previous = [[{'name': '_idFileRow', 'value': '10'}]]
        source = ('<form><section id="Version"><input name="version" value="1.0"></section>'
                  '<input name="files" value="' + html.escape(json.dumps(previous), quote=True) + '"></form>')
        with patch.object(publisher, 'attached_files', side_effect=[None, None, [100]]), patch.object(publisher, 'metadata', side_effect=[{'_sVersion': '1.0'}, {'_sVersion': '1.0'}, {'_sVersion': '1.1'}]), patch.object(publisher, '_get_edit_page', return_value=source), patch.object(publisher, '_get_upload_fields', return_value=('receipt', 'files', 'images')), patch.object(publisher, '_find_ownership_fields', return_value=[]), patch.object(publisher, 'files', return_value=[{'_idRow': 10}]), patch.object(publisher, 'upload_zip', return_value={'file_row_id': 100}) as upload, patch.object(publisher, 'post_edit') as edit, patch.object(api.time, 'sleep') as sleep:
            self.assertEqual(publisher.register_files([pathlib.Path('fixture.zip')], '1.1'), [100])
        upload.assert_called_once()
        edit.assert_called_once()
        sleep.assert_called_once_with(10)

    def test_incomplete_edit_file_list_aborts_before_upload_or_submission(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        source = '<form><section id="Version"><input name="version" value="1.0"></section><input name="files" value="[]"></form>'
        with patch.object(publisher, 'attached_files', return_value=None), patch.object(publisher, 'metadata', return_value={}), patch.object(publisher, '_get_edit_page', return_value=source), patch.object(publisher, '_get_upload_fields', return_value=('receipt', 'files', 'images')), patch.object(publisher, '_find_ownership_fields', return_value=[]), patch.object(publisher, 'files', return_value=[{'_idRow': 100}]), patch.object(publisher, 'upload_zip') as upload, patch.object(publisher, 'post_edit') as edit:
            with self.assertRaisesRegex(RuntimeError, 'complete file list'):
                publisher.register_files([], '1.1')
            upload.assert_not_called()
            edit.assert_not_called()

    def test_credits_preserve_collaborators_and_roles(self):
        publisher = api.Publisher('fixture', 'fixture', 674856)
        publisher.original_metadata = {'_aCredits': {'Authors': [['Predi_i', 'Mod Maker', 5107678, ''], ['Collaborator', 'UI Designer', 5641500, '']]}}
        fields = publisher._find_ownership_fields('var g_sInputName = "' + 'a' * 32 + '";')
        self.assertIn(('a' * 32 + '[1][author_names][]', 'Collaborator'), fields)
        self.assertIn(('a' * 32 + '[1][author_roles][]', 'UI Designer'), fields)
        self.assertIn(('a' * 32 + '[1][group_name]', 'Authors'), fields)

    def test_file_registration_preserves_description_images_license_ai_and_existing_files(self):
        publisher = api.Publisher('fixture', 'fixture', 674856)
        previous = [[{'name': '_idFileRow', 'value': 'old-file'}]]
        source = ('<form><section id="Version"><input name="version" value="1.5"></section>'
                  '<section id="Description"><textarea name="description">Existing description</textarea></section>'
                  '<input name="images" value="' + html.escape('[{"name":"caption","value":"existing caption"}]', quote=True) + '">'
                  '<input name="files" value="' + html.escape(json.dumps(previous), quote=True) + '">'
                  '<textarea name="license">Existing license</textarea>'
                  '<input name="ai" type="radio" value="existing" checked></form>')
        response = MagicMock(url='https://gamebanana.com/mods/674856', history=[], headers={}, text='ok', status_code=200)
        with patch.object(publisher, '_get_edit_page', return_value=source), patch.object(publisher, '_find_ownership_fields', return_value=[]), patch.object(publisher, '_request', return_value=response) as request:
            publisher.post_edit([{'file_row_id': 100, 'upload_receipt_id': 'fixture'}], '1.6', 'files', 'images', preserve_metadata=True)
        fields = request.call_args.kwargs['data']
        self.assertIn(('description', 'Existing description'), fields)
        self.assertIn(('license', 'Existing license'), fields)
        self.assertIn(('ai', 'existing'), fields)
        self.assertIn(('images', '[{"name":"caption","value":"existing caption"}]'), fields)
        files = json.loads(dict(fields)['files'])
        self.assertEqual(files[0], previous[0])
        self.assertEqual(files[1][2]['value'], '100')


if __name__ == '__main__':
    unittest.main()
