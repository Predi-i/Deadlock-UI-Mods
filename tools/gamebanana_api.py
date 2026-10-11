"""Publish reviewed GitHub archives and create a real GameBanana Add Update API record."""
import argparse
import hashlib
import json
import logging
import os
import pathlib
import re
import tempfile
import time

import requests
from gb_upload import GameBananaUploader, BeautifulSoup, GB_BASE, logger
from mod_releases import CATALOG, ROOT, hashes, latest, read_releases, gh
from package_releases import release_plan
from gamebanana_queue import download_record, store_record

NOTE = "Updated to the game's latest update."
UPDATE_API = "https://gamebanana.com/apiv13"


def next_version(current, override=""):
    value = override.strip()
    if value:
        if not re.fullmatch(r"\d+(?:\.\d+){1,2}", value):
            raise ValueError("Use a numeric GameBanana version such as 1.1 or 1.1.0")
        if re.fullmatch(r"\d{1,3}(?:\.\d+){1,2}", current or ""):
            previous = tuple(map(int, current.split(".")))
            proposed = tuple(map(int, value.split(".")))
            length = max(len(previous), len(proposed))
            if proposed + (0,) * (length - len(proposed)) <= previous + (0,) * (length - len(previous)):
                raise ValueError("The new GameBanana version must be greater than its current numeric version")
        return value
    if not re.fullmatch(r"\d{1,3}(?:\.\d+){1,2}", current or ""):
        # Older publications used calendar dates. Start the requested numeric series.
        return "1.1"
    parts = current.split(".")
    parts[-1] = str(int(parts[-1]) + 1)
    return ".".join(parts)


def verify_archives(mod, release, folder):
    metadata = json.loads((folder / "release.json").read_text(encoding="utf-8"))
    if any(metadata.get(key) != release[key] for key in ("mod", "commit", "hashes")):
        raise ValueError("Downloaded release does not match the selected source checkpoint")
    expected = {item["name"] + ".zip" for item in release_plan(CATALOG[mod]["sources"])}
    files = metadata.get("files", [])
    if len(files) != len(expected) or {item["name"] for item in files} != expected:
        raise ValueError("Release is missing a supported mod variant or contains unrelated archives")
    for item in files:
        path = folder / item["name"]
        if not path.is_file() or path.stat().st_size != item["size"] or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("Release archive checksum mismatch: " + item["name"])
    return [folder / item["name"] for item in files]


class Publisher(GameBananaUploader):
    def _request(self, method, url, **kwargs):
        kwargs.pop("max_retries", None)
        try:
            response = self.session.request(method, url, timeout=30, **kwargs)
            response.raise_for_status()
            return response
        except requests.RequestException:
            # Credentials, receipts and HTML must never appear in Actions logs.
            raise RuntimeError("GameBanana request failed; reconcile the publication before retrying") from None

    def api(self, route, method="GET", payload=None, update=False):
        base = UPDATE_API if update else "https://gamebanana.com/apiv11"
        if method == "GET":
            # Public API projections can remain in the CDN for ten minutes,
            # including after an authenticated edit. A unique read URL avoids
            # accepting a stale acknowledgement or uploading a file twice.
            route += ("&" if "?" in route else "?") + "_=" + str(time.time_ns())
        response = self._request(method, base + "/" + route, **({"json": payload} if payload is not None else {}))
        try:
            data = response.json()
        except ValueError:
            raise RuntimeError("GameBanana returned a non-JSON API response") from None
        if isinstance(data, dict) and data.get("_sErrorCode"):
            raise RuntimeError("GameBanana API rejected the operation: " + str(data["_sErrorCode"]))
        return data

    def metadata(self):
        return self.api(f"Mod/{self.mod_id}?_csvProperties=_sVersion,_sText,_aCredits,_aPreviewMedia,_sLicense")

    def _find_ownership_fields(self, html):
        match = re.search(r'var\s+g_sInputName\s*=\s*"([a-f0-9]{32})"', html)
        credits = self.original_metadata.get("_aCredits")
        if not match or not isinstance(credits, dict) or not credits:
            raise RuntimeError("Cannot preserve the submission's existing ownership/credits; no edit submitted")
        fields = []
        for index, (group, authors) in enumerate(credits.items(), 1):
            prefix = f"{match[1]}[{index}]"
            fields.append((prefix + "[group_name]", group))
            for author in authors:
                if len(author) != 4:
                    raise RuntimeError("GameBanana credit schema changed; no edit submitted")
                name, role, member, url = author
                fields.extend([(prefix + "[author_userids][]", str(member or "")),
                               (prefix + "[author_names][]", name), (prefix + "[author_offsite_urls][]", url),
                               (prefix + "[author_roles][]", role)])
        return fields

    def _log_edit_error(self, html):
        logger.error("GameBanana rejected the file-registration form; inspect its current structure.")

    def files(self):
        return self.api(f"Mod/{self.mod_id}/Files", update=True)

    def _preserved_form_fields(self, html, files_field, image_field):
        fields = self._scrape_form(html)
        values = dict(fields)
        file_entries, image_entries = [], []
        soup = BeautifulSoup(html, "html.parser")
        for script in soup.find_all("script"):
            code = script.get_text()
            for match in re.finditer(r"\bvar\s+file\s*=\s*(\{)", code):
                try:
                    record, _ = json.JSONDecoder().raw_decode(code[match.start(1):])
                except ValueError:
                    raise RuntimeError("GameBanana file initializer changed; no edit submitted") from None
                if "_idFileRow" in record:
                    # The site creates these inputs on page load and serializes
                    # them on submit. The hidden HTML field starts empty.
                    template = [BeautifulSoup(tag[0], "html.parser").find("input")
                                for tag in re.finditer(r"<input\b[^>]*>", code)]
                    names = {el.get("name") for el in template if el}
                    expected = {"_sDescription", "_sVersion", "_bIsArchived", "_idFileRow", "_sUploadReceiptId"}
                    if not expected.issubset(names) or any(name and name.startswith("_") and name not in expected | {"_sCaption", "_sTicketId"} for name in names):
                        raise RuntimeError("GameBanana file template changed; no edit submitted")
                    if not any(el and el.get("name") == "_bIsArchived" and el.get("type") == "checkbox" and el.get("value") == "1" for el in template):
                        raise RuntimeError("GameBanana archive control changed; no edit submitted")
                    if type(record.get("_bIsArchived")) is not bool or not str(record["_idFileRow"]).isdigit():
                        raise RuntimeError("GameBanana existing file schema changed; no edit submitted")
                    entry = [{"name": key, "value": str(record.get(key) or "")} for key in ("_sDescription", "_sVersion")]
                    if record["_bIsArchived"]:
                        entry.append({"name": "_bIsArchived", "value": "1"})
                    entry.extend([{"name": "_idFileRow", "value": str(record["_idFileRow"])},
                                  {"name": "_sUploadReceiptId", "value": str(record.get("_sUploadReceiptId", "undefined"))}])
                    file_entries.append(entry)
                elif "_sTicketId" in record:
                    image_entries.extend([{"name": "_sCaption", "value": str(record.get("_sCaption") or "")},
                                          {"name": "_sTicketId", "value": record["_sTicketId"]}])
        replacements = {}
        for name, entries in ((files_field, file_entries), (image_field, image_entries)):
            if entries and name and name in values:
                try:
                    current = json.loads(values[name] or "[]")
                except ValueError:
                    raise RuntimeError("GameBanana hidden form schema changed; no edit submitted") from None
                if not current:
                    replacements[name] = json.dumps(entries)
        return [(name, replacements.get(name, value)) for name, value in fields]

    def attached_files(self, archives, version):
        records = self.files()
        found = []
        for archive in archives:
            md5 = hashlib.md5(archive.read_bytes()).hexdigest()
            matches = [file for file in records if file.get("_sMd5Checksum") == md5
                       and file.get("_sVersion") == version and not file.get("_bIsArchived")]
            if len(matches) > 1:
                raise RuntimeError("Ambiguous GameBanana files; reconcile the previous upload")
            if not matches:
                return None
            found.append(matches[0]["_idRow"])
        return found

    def register_files(self, archives, version, allow_upload=True):
        found = self.attached_files(archives, version)
        if found:
            if not self.file_state_ready(found):
                raise RuntimeError("Uploaded files exist but previous files remain active; reconcile before adding an update")
            return found
        if not allow_upload:
            raise RuntimeError("Previously submitted Add Update files are not acknowledged; reconcile before uploading again")
        if any(file.get("_sVersion") == version and not file.get("_bIsArchived") and not file.get("_sMd5Checksum") for file in self.files()):
            raise RuntimeError("GameBanana is still analysing files for this version; wait before retrying. No duplicate archives uploaded")
        sdpid, files_field, image_field = self.verify_edit_form()
        uploads = [self.upload_zip(archive, sdpid) for archive in archives]
        self.post_edit(uploads, version, files_field, image_field, preserve_metadata=True, archive_previous=True)
        for attempt in range(4):
            after = self.metadata()
            for key in ("_sText", "_aCredits", "_aPreviewMedia", "_sLicense"):
                if after.get(key) != self.original_metadata.get(key):
                    raise RuntimeError("GameBanana changed submission metadata; inspect it before creating an update")
            found = self.attached_files(archives, version)
            if found and after.get("_sVersion") == version and self.file_state_ready(found):
                return found
            if attempt < 3:
                time.sleep(10)
        raise RuntimeError("GameBanana has not acknowledged all files/version; retry after cache settlement")

    def verify_edit_form(self):
        """Read and validate the authenticated edit form without uploading or editing."""
        self.original_metadata = self.metadata()
        html = self._get_edit_page()
        sdpid, files_field, image_field = self._get_upload_fields(html)
        # Validate current credits and editable fields before uploading anything.
        self._find_ownership_fields(html)
        soup = BeautifulSoup(html, "html.parser")
        version_section = soup.find(id="Version")
        version_input = version_section.find("input") if version_section else None
        if not files_field or not version_input or not version_input.get("name"):
            raise RuntimeError("GameBanana file/version form changed; no archives uploaded")
        scraped = self._preserved_form_fields(html, files_field, image_field)
        if self.original_metadata.get("_sText") and not self._find_description_field(soup, scraped):
            raise RuntimeError("Cannot preserve GameBanana's description; no archives uploaded")
        original_fields = dict(scraped)
        previous_files = original_fields.get(files_field, "")
        if previous_files:
            try:
                previous_files = json.loads(previous_files)
            except ValueError:
                raise RuntimeError("Cannot preserve GameBanana's existing file list; no archives uploaded") from None
            if not isinstance(previous_files, list) or any(not isinstance(item, list) for item in previous_files):
                raise RuntimeError("GameBanana file-list schema changed; no archives uploaded")
        previous_ids = {str(field.get("value")) for entry in (previous_files or []) for field in entry
                        if isinstance(field, dict) and field.get("name") == "_idFileRow"}
        records = self.files()
        attached_ids = {str(file["_idRow"]) for file in records}
        if previous_ids != attached_ids:
            active_ids = {str(file["_idRow"]) for file in records if not file.get("_bIsArchived")}
            raise RuntimeError("Cannot preserve GameBanana's complete file list; no archives uploaded. "
                               f"Form IDs: {sorted(previous_ids)}; active API IDs: {sorted(active_ids)}; "
                               f"all API IDs: {sorted(attached_ids)}")
        self.original_file_ids = attached_ids
        preview = self.original_metadata.get("_aPreviewMedia") or {}
        images = preview.get("_aImages", []) if isinstance(preview, dict) else preview
        if images:
            try:
                image_values = json.loads(original_fields.get(image_field, ""))
            except ValueError:
                raise RuntimeError("Cannot preserve GameBanana's existing images; no archives uploaded") from None
            if not image_values:
                raise RuntimeError("GameBanana image form is incomplete; no archives uploaded")
        return sdpid, files_field, image_field

    def file_state_ready(self, file_ids):
        records = self.files()
        ids = {str(file["_idRow"]) for file in records}
        active = {file["_idRow"] for file in records if not file.get("_bIsArchived")}
        return active == set(file_ids) and getattr(self, "original_file_ids", set()).issubset(ids)

    def find_update_record(self, version, file_ids):
        page = 1
        while True:
            data = self.api(f"Mod/{self.mod_id}/Updates?_nPage={page}&_nPerpage=50", update=True)
            for record in data["_aRecords"]:
                if record.get("_sVersion") == version:
                    ids = {file["_idRow"] for file in record.get("_aFiles", [])}
                    if ids == set(file_ids):
                        return record
                    raise RuntimeError("This GameBanana version already has a different update; reconcile it first")
            if data["_aMetadata"].get("_bIsComplete", True):
                return None
            page += 1

    def find_update(self, version, file_ids):
        record = self.find_update_record(version, file_ids)
        return record["_idRow"] if record else None

    def repair_publication(self, receipt, dry_run=False):
        """Correct an acknowledged publication without uploading or adding another update."""
        version, file_ids = receipt["version"], receipt["file_ids"]
        authenticate_publisher(self)
        if self.metadata().get("_sVersion") != version:
            raise RuntimeError("A newer GameBanana version exists; no old publication repaired")
        record = self.find_update_record(version, file_ids)
        if not record or record["_idRow"] != receipt["update_id"]:
            raise RuntimeError("Published update does not match its receipt; no repair submitted")
        files = self.files()
        if not set(file_ids).issubset({file["_idRow"] for file in files if not file.get("_bIsArchived")}):
            raise RuntimeError("Published files are missing or archived; no repair submitted")
        old_ids = [file["_idRow"] for file in files if not file.get("_bIsArchived") and file["_idRow"] not in file_ids]
        duplicate = record.get("_sText") == NOTE
        _, files_field, image_field = self.verify_edit_form()
        print(f"Published version {version}: archive previous files {old_ids}; remove duplicate blurb: {duplicate}")
        if dry_run:
            print("Preview complete: no files, updates or versions changed.")
            return
        if old_ids:
            self.post_edit([], version, files_field, image_field, preserve_metadata=True,
                           archive_previous=True, keep_file_ids=file_ids)
        if duplicate:
            payload = {"_sName": record["_sName"], "_sVersion": version, "_sText": "",
                       "_aChangeLog": record["_aChangeLog"], "_aFileRowIds": file_ids,
                       "_bIsSignificant": record["_bIsSignificant"]}
            self.api(f"Update/{record['_idRow']}", "PATCH", payload, update=True)
        for attempt in range(4):
            current = self.find_update_record(version, file_ids)
            after = self.metadata()
            if any(after.get(key) != self.original_metadata.get(key) for key in ("_sText", "_aCredits", "_aPreviewMedia", "_sLicense")):
                raise RuntimeError("Submission metadata changed during repair; inspect it")
            if current and current["_idRow"] == receipt["update_id"] and current.get("_aChangeLog") == record.get("_aChangeLog") and (not duplicate or not current.get("_sText")) and after.get("_sVersion") == version and self.file_state_ready(file_ids):
                print(f"Existing GameBanana update {receipt['update_id']} corrected; version {version}; no new upload or update.")
                return
            if attempt < 3:
                time.sleep(10)
        raise RuntimeError("GameBanana repair acknowledgement pending; inspect before retrying")

    def wait_update(self, version, file_ids):
        for attempt in range(4):
            existing = self.find_update(version, file_ids)
            if existing:
                return existing
            if attempt < 3:
                time.sleep(10)
        return None

    def add_update(self, version, file_ids):
        existing = self.find_update(version, file_ids)
        if existing:
            return existing
        payload = {"_sName": "Game compatibility update", "_sVersion": version,
                   "_sText": "", "_aChangeLog": [{"text": NOTE, "cat": "Improvement"}],
                   "_aFileRowIds": file_ids, "_bIsSignificant": False}
        data = self.api(f"Mod/{self.mod_id}/Update", "POST", payload, update=True)
        update_id = data.get("_idRow") if isinstance(data, dict) else None
        # The site may acknowledge creation with a success message instead of an ID.
        # Resolve its record through the read API; never repeat the POST blindly.
        if not update_id:
            update_id = self.wait_update(version, file_ids)
        if not update_id:
            raise RuntimeError("GameBanana did not acknowledge Add Update; reconcile before retrying")
        return update_id


def finish_update(publisher, repository, release, reservation, version, file_ids):
    if reservation.get("add_update_started"):
        if set(reservation.get("file_ids", [])) != set(file_ids):
            raise RuntimeError("Reserved Add Update files changed; reconcile the publication first")
        update_id = publisher.wait_update(version, file_ids)
        if not update_id:
            raise RuntimeError("Add Update was already attempted but remains unacknowledged; reconcile it before another POST")
        return update_id
    # Persist intent before the mutation: a lost response must not cause another
    # workflow run to POST the same update while the read API is still cached.
    store_record(repository, release["tag"], "gamebanana-progress.json",
                 {**reservation, "add_update_started": True, "file_ids": file_ids})
    return publisher.add_update(version, file_ids)


def authenticate_publisher(publisher):
    if not publisher.username or not publisher.password:
        raise ValueError("Configure GB_USERNAME and GB_PASSWORD in GitHub Secrets")
    publisher.authenticate()
    if not publisher.session.headers.get("Authorization") and not publisher.session.cookies:
        raise RuntimeError("GameBanana authentication was not acknowledged")
    access = publisher.api(f"Mod/{publisher.mod_id}/Config", update=True)
    if not access.get("_aAccess", {}).get("Update_Add"):
        raise RuntimeError("Authenticated account cannot add updates to this GameBanana submission")


def publish(repository, mod, override="", dry_run=False, automatic_css=False, expected_base=None):
    if mod not in CATALOG or not CATALOG[mod]["gamebanana_id"]:
        raise ValueError("This mod has no verified GameBanana submission in the catalog")
    manifest = json.loads((ROOT / "tools/upstream.json").read_text(encoding="utf-8"))
    if any("pending" in entry and entry["path"].split("/")[0] in CATALOG[mod]["sources"] for entry in manifest["files"]):
        raise ValueError("This mod has unresolved native overrides")
    release = latest(read_releases(repository)).get(mod)
    if not release or release["hashes"] != hashes(mod):
        raise ValueError("Wait for a successful compiled release matching current main sources")
    done = download_record(repository, release, "gamebanana-published.json")
    logger.setLevel(logging.WARNING)
    publisher = Publisher(os.environ.get("GB_USERNAME", ""), os.environ.get("GB_PASSWORD", ""), CATALOG[mod]["gamebanana_id"])
    if done and done.get("hashes") == release["hashes"] and done.get("update_id"):
        if not automatic_css:
            publisher.repair_publication(done, dry_run)
        return
    metadata = publisher.metadata()
    reservation = download_record(repository, release, "gamebanana-progress.json")
    if automatic_css:
        if not expected_base or not expected_base.get("version") or not expected_base.get("file_ids"):
            raise ValueError("Automatic CSS publication requires a confirmed GB baseline")
        if reservation:
            if reservation.get("previous_version") != expected_base["version"]:
                raise ValueError("CSS reservation does not match the last GB publication")
        elif metadata.get("_sVersion") != expected_base["version"] or {file["_idRow"] for file in publisher.files() if not file.get("_bIsArchived")} != set(expected_base["file_ids"]):
            raise ValueError("GameBanana changed outside the confirmed baseline; review before automatic publication")
    if reservation and reservation.get("hashes") != release["hashes"]:
        raise ValueError("Publication reservation does not match this release")
    if reservation and metadata.get("_sVersion") not in (reservation.get("previous_version"), reservation["version"]):
        raise ValueError("GameBanana version changed outside this attempt; reconcile the reserved publication first")
    version = reservation["version"] if reservation else next_version(metadata.get("_sVersion"), override)
    if reservation and override and override != version:
        raise ValueError("A previous attempt reserved a different version; reconcile it before changing the version")
    print(f"{mod}: GameBanana {metadata.get('_sVersion', 'unknown')} -> {version}; {NOTE}")
    with tempfile.TemporaryDirectory() as folder:
        folder = pathlib.Path(folder)
        gh("release", "download", release["tag"], "--repo", repository, "--pattern", "*.zip", "--pattern", "release.json", "--dir", str(folder))
        archives = verify_archives(mod, release, folder)
        authenticate_publisher(publisher)
        if dry_run:
            publisher.verify_edit_form()
            print("Preview complete: release checksums, authentication, permissions and edit form verified; "
                  "no uploads, edits, Add Update or version reservation.")
            return
        if not reservation:
            reservation = {"hashes": release["hashes"], "version": version, "previous_version": metadata.get("_sVersion")}
            store_record(repository, release["tag"], "gamebanana-progress.json", reservation)
        file_ids = publisher.register_files(archives, version, allow_upload=not reservation.get("add_update_started"))
        update_id = finish_update(publisher, repository, release, reservation, version, file_ids)
        store_record(repository, release["tag"], "gamebanana-published.json",
                     {"mod": mod, "hashes": release["hashes"], "version": version, "update_id": update_id,
                      "file_ids": file_ids, "gamebanana_id": publisher.mod_id,
                      "automatic_css": automatic_css, "notification_requested": True})
    print(f"GameBanana Add Update acknowledged: {update_id}; version {version}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--mod", required=True)
    parser.add_argument("--version", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not args.repository:
        parser.error("Specify the GitHub repository")
    publish(args.repository, args.mod, args.version, args.dry_run)


if __name__ == "__main__":
    main()
