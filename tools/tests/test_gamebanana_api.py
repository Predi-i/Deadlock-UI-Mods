import html
import json
import pathlib
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import gamebanana_api as api


class GameBananaApiTests(unittest.TestCase):
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
        with patch.object(publisher, 'find_update', return_value=None), patch.object(publisher, 'api', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'did not acknowledge'):
                publisher.add_update('1.1', [100])

    def test_success_message_is_resolved_to_existing_record_without_another_post(self):
        publisher = api.Publisher('fixture', 'fixture', 656390)
        with patch.object(publisher, 'find_update', side_effect=[None, 42]), patch.object(publisher, 'api', return_value={'_sSuccessCode': 'Success'}) as request:
            self.assertEqual(publisher.add_update('1.1', [100]), 42)
            self.assertEqual(request.call_count, 1)

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
