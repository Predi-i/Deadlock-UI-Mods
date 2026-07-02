"""
GameBanana uploader for Show-Nicknames-In-TopBar.
Usage: python tools/gb_upload.py <zip_path> <version>
  e.g. python tools/gb_upload.py builds/Show-Nicknames-In-TopBar.zip 2026.07.02

Required env vars:
  GB_USERNAME  — GameBanana login
  GB_PASSWORD  — GameBanana password

Adapted from https://github.com/Mackamuir/unstoppable (publisher.py).
"""

import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("gb_upload")

CHUNK_SIZE = 1024 * 1024  # 1 MB
GB_BASE = "https://gamebanana.com"
GB_API_BASE = "https://gamebanana.com/apiv11"
GB_UPLOAD_URL = f"{GB_BASE}/responders/jfuare"

MOD_ID = 656390

DESCRIPTION = (
    "Shows Steam nicknames of all players above their hero icons in the top bar during a match.<br><br>"
    "Compatible with all heroes and both teams.<br><br>"
    "<b>Installation:</b> place the VPK in <code>Deadlock/game/citadel/addons/</code><br><br>"
    "This mod is automatically updated when Deadlock patches. "
    "Source: <a href='https://github.com/Predi-i/Deadlock-UI-Mods'>GitHub</a>"
)


class GameBananaUploader:
    def __init__(self, username: str, password: str, mod_id: int):
        self.username = username
        self.password = password
        self.mod_id = mod_id
        self._submitter: tuple[str, str] | None = None
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/145.0.0.0 Safari/537.36"
            ),
        })

    # ── HTTP with retry ───────────────────────────────────────────────────

    def _request(self, method, url, max_retries=5, base_delay=10.0, max_delay=120.0, **kwargs):
        for attempt in range(1, max_retries + 1):
            try:
                resp = self.session.request(method, url, **kwargs)
            except (requests.ConnectionError, requests.Timeout) as e:
                if attempt == max_retries:
                    raise
                delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
                logger.warning("%s %s attempt %d/%d connection error: %s (retry in %.0fs)",
                               method.upper(), url, attempt, max_retries, e, delay)
                time.sleep(delay)
                continue

            if resp.status_code < 500:
                return resp

            if attempt == max_retries:
                resp.raise_for_status()

            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            logger.warning("%s %s attempt %d/%d status %d (retry in %.0fs)",
                           method.upper(), url, attempt, max_retries, resp.status_code, delay)
            time.sleep(delay)

    # ── Auth ──────────────────────────────────────────────────────────────

    def authenticate(self):
        self.session.headers.pop("Authorization", None)
        self.session.cookies.clear()
        resp = self._request(
            "POST",
            f"{GB_API_BASE}/Member/Authenticate",
            json={"_sUsername": self.username, "_sPassword": self.password},
        )
        resp.raise_for_status()
        data = resp.json()
        token = data.get("_sToken") or data.get("token")
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"
        logger.info("Authenticated as %s", self.username)

    # ── Mod ownership ─────────────────────────────────────────────────────

    def get_submitter(self) -> tuple[str, str] | None:
        """Return (user_id, display_name) of the mod's owner from the GB API.

        We credit whoever actually owns the mod (i.e. you), so no author info
        is ever hardcoded. Returns None if the API doesn't expose a submitter.
        """
        resp = self._request(
            "GET",
            f"{GB_API_BASE}/Mod/{self.mod_id}",
            params={"_csvProperties": "_aSubmitter"},
        )
        resp.raise_for_status()
        if not resp.text:
            logger.warning("Submitter API returned empty body (status=%d)", resp.status_code)
            return None
        submitter = resp.json().get("_aSubmitter") or {}
        user_id = submitter.get("_idRow")
        name = submitter.get("_sName")
        if not user_id or not name:
            logger.warning("Could not resolve mod submitter from API: %r", submitter)
            return None
        logger.info("Mod submitter: id=%s name=%s", user_id, name)
        return str(user_id), name

    # ── Edit page helpers ─────────────────────────────────────────────────

    def _get_edit_page(self) -> str:
        resp = self._request("GET", f"{GB_BASE}/mods/edit/{self.mod_id}",
                             headers={"accept": "text/html"})
        resp.raise_for_status()
        return resp.text

    def _get_upload_fields(self, html: str) -> tuple[str, str, str]:
        """Return (sdpid, files_field_hash, image_field_hash)."""
        match = re.search(
            r'#([a-f0-9]{32})_FileInput"\)\.fileupload\(\{\s*formData:\s*\{\s*"sdpid"\s*:\s*"([a-f0-9]{32})"',
            html, re.DOTALL,
        )
        if not match:
            match = re.search(r'"sdpid"\s*:\s*"([a-f0-9]{32})"', html)
            if match:
                sdpid = match.group(1)
                logger.warning("Found sdpid %s but could not determine field names", sdpid)
                return sdpid, "", ""
            raise RuntimeError(f"Could not find sdpid in edit page HTML ({len(html)} chars)")

        files_field = match.group(1)
        sdpid = match.group(2)

        image_field = ""
        img_match = re.search(
            r'#([a-f0-9]{32})_FileInput"\)\.fileupload\(\{\s*formData:\s*\{\s*"d"\s*:',
            html, re.DOTALL,
        )
        if img_match:
            image_field = img_match.group(1)

        logger.info("sdpid=%s files_field=%s image_field=%s", sdpid, files_field, image_field)
        return sdpid, files_field, image_field

    # ── Chunked upload ────────────────────────────────────────────────────

    def upload_zip(self, zip_path: Path, sdpid: str):
        total_size = zip_path.stat().st_size
        filename = zip_path.name
        result = None

        logger.info("Uploading %s (%.2f MB)", filename, total_size / 1048576)

        with open(zip_path, "rb") as f:
            offset = 0
            chunk_num = 0
            while offset < total_size:
                chunk = f.read(CHUNK_SIZE)
                end = offset + len(chunk) - 1
                chunk_num += 1

                resp = self._request(
                    "POST",
                    GB_UPLOAD_URL,
                    headers={
                        "content-range": f"bytes {offset}-{end}/{total_size}",
                        "x-requested-with": "XMLHttpRequest",
                        "origin": GB_BASE,
                        "referer": f"{GB_BASE}/mods/edit/{self.mod_id}",
                        "accept": "application/json, text/javascript, */*; q=0.01",
                    },
                    files=[
                        ("sdpid", (None, sdpid)),
                        ("files[]", (filename, chunk, "application/x-zip-compressed")),
                    ],
                )
                logger.info("Chunk %d: status=%d body=%r",
                            chunk_num, resp.status_code, resp.text[:300])
                resp.raise_for_status()

                if not resp.text:
                    offset += len(chunk)
                    continue

                data = resp.json()
                if "files" in data:
                    file_info = data["files"][0]
                    if "error" in file_info:
                        raise RuntimeError(f"Upload error: {file_info['error']}")
                    result = {
                        "file_row_id": file_info["_idFileRow"],
                        "upload_receipt_id": file_info["_sUploadReceiptId"],
                        "filename": file_info["_sFile"],
                    }
                    logger.info("Upload complete: id=%d receipt=%s",
                                result["file_row_id"], result["upload_receipt_id"])

                offset += len(chunk)

        if result is None:
            raise RuntimeError("Upload finished but no _idFileRow in response")
        return result

    # ── Form scraping ─────────────────────────────────────────────────────

    def _scrape_form(self, html: str) -> list[tuple[str, str]]:
        soup = BeautifulSoup(html, "html.parser")
        form = soup.find("form")
        if not form:
            raise RuntimeError("No <form> found in edit page HTML")

        fields: list[tuple[str, str]] = []
        for el in form.find_all(["input", "textarea", "select"]):
            name = el.get("name")
            if not name or el.has_attr("disabled"):
                continue

            if el.name == "textarea":
                fields.append((name, el.string or ""))
            elif el.name == "select":
                if el.has_attr("multiple"):
                    for opt in el.find_all("option", selected=True):
                        fields.append((name, opt.get("value", "")))
                else:
                    selected = el.find("option", selected=True)
                    fields.append((name, selected.get("value", "") if selected else ""))
            elif el.name == "input":
                input_type = (el.get("type") or "text").lower()
                if input_type in ("submit", "button", "file", "image"):
                    continue
                if input_type == "checkbox":
                    if el.has_attr("checked"):
                        fields.append((name, el.get("value", "on")))
                elif input_type == "radio":
                    if el.has_attr("checked"):
                        fields.append((name, el.get("value", "")))
                else:
                    fields.append((name, el.get("value", "")))

        logger.info("Scraped %d form fields", len(fields))
        return fields

    def _find_ownership_fields(self, html: str) -> list[tuple[str, str]]:
        """Build the JS-generated ownership block crediting only the mod owner.

        The author here is resolved dynamically from the mod's own submitter
        (see get_submitter), never hardcoded, so the credited author is always
        whoever owns the mod. If the prefix or submitter can't be resolved we
        return an empty list — the edit then leaves ownership untouched.
        """
        match = re.search(r'var\s+g_sInputName\s*=\s*"([a-f0-9]{32})"', html)
        if not match:
            logger.warning("Could not find g_sInputName; leaving ownership untouched")
            return []
        if not self._submitter:
            logger.warning("No submitter resolved; leaving ownership untouched")
            return []
        prefix = match.group(1)
        user_id, name = self._submitter
        return [
            (f"{prefix}[1][group_name]", "Developer"),
            (f"{prefix}[1][author_userids][]", user_id),
            (f"{prefix}[1][author_names][]", name),
            (f"{prefix}[1][author_offsite_urls][]", ""),
            (f"{prefix}[1][author_roles][]", "Author"),
        ]

    def _find_ticket_ids(self, html: str) -> list[str]:
        return re.findall(
            r'[Tt]icket[Ii]d["\']?\s*[:=,]\s*["\']([a-f0-9]{32})["\']', html
        )

    def _find_js_template_fields(self, html: str) -> list[tuple[str, str]]:
        fields: list[tuple[str, str]] = []

        m = re.search(r'name="([a-f0-9]{32})\[\]"[^>]*placeholder="URL or Embed Code', html)
        if m:
            fields.append((f"{m.group(1)}[]", ""))

        m = re.search(r'name="([a-f0-9]{32})\[_aUrls\]\[\]"', html)
        if m:
            prefix = m.group(1)
            fields.append((f"{prefix}[_aUrls][]", ""))
            fields.append((f"{prefix}[_aDescriptions][]", ""))

        m = re.search(
            r'name="([a-f0-9]{32})\[_aDescriptions\]\[\]"[^>]*placeholder="Requirement', html)
        if not m:
            m = re.search(
                r'placeholder="Requirement[^"]*"[^>]*name="([a-f0-9]{32})\[_aDescriptions\]\[\]"', html)
        if m:
            prefix = m.group(1)
            fields.append((f"{prefix}[_aDescriptions][]", ""))
            fields.append((f"{prefix}[_aUrls][]", ""))
            fields.append((f"{prefix}[_aActions][]", "< select >"))
            fields.append((f"{prefix}[_aActionRecommendations][]", "< select >"))

        return fields

    # ── Edit form submit ──────────────────────────────────────────────────

    def post_edit(self, upload: dict, version: str, description: str,
                  files_json_name: str, image_json_name: str):
        html = self._get_edit_page()
        fields = self._scrape_form(html)
        soup = BeautifulSoup(html, "html.parser")

        # Find description textarea by content prefix
        desc_name = None
        for name, value in fields:
            if value and ("nicknames" in value.lower() or "top bar" in value.lower()
                          or "topbar" in value.lower() or "steam" in value.lower()):
                desc_name = name
                break
        # Fallback: first large textarea
        if not desc_name:
            for name, value in fields:
                if len(value) > 30:
                    desc_name = name
                    break

        # Find version field inside #Version section
        version_field_name = None
        version_section = soup.find(id="Version")
        if version_section:
            version_input = version_section.find("input")
            if version_input:
                version_field_name = version_input.get("name")
        logger.info("desc_field=%s version_field=%s", desc_name, version_field_name)

        file_entries = [[
            {"name": "_sDescription", "value": ""},
            {"name": "_sVersion", "value": str(version)},
            {"name": "_idFileRow", "value": str(upload["file_row_id"])},
            {"name": "_sUploadReceiptId", "value": upload["upload_receipt_id"]},
        ]]

        ticket_ids = self._find_ticket_ids(html)
        image_json_entries = []
        image_individual_fields = []
        for i, tid in enumerate(ticket_ids):
            image_json_entries.append({"name": "_sCaption", "value": "icon" if i == 0 else ""})
            image_json_entries.append({"name": "_sTicketId", "value": tid})
            image_individual_fields.append(("_sCaption", "icon" if i == 0 else ""))
            image_individual_fields.append(("_sTicketId", ""))

        ownership_fields = self._find_ownership_fields(html)
        js_template_fields = self._find_js_template_fields(html)

        files_json_value = json.dumps(file_entries)
        image_json_value = json.dumps(image_json_entries) if image_json_entries else "[]"

        first_true_index = next(
            (i for i, (_, v) in enumerate(fields) if v == "true"), None)

        form_data: list[tuple[str, str]] = []
        for i, (name, value) in enumerate(fields):
            if desc_name and name == desc_name:
                form_data.append((name, description))
            elif version_field_name and name == version_field_name:
                form_data.append((name, str(version)))
            elif image_json_name and name == image_json_name:
                for fname, fval in image_individual_fields:
                    form_data.append((fname, fval))
                form_data.append((name, image_json_value))
            elif files_json_name and name == files_json_name:
                for file_entry in file_entries:
                    for field in file_entry:
                        form_data.append((field["name"], field["value"]))
                form_data.append((name, files_json_value))
                for tname, tval in js_template_fields:
                    form_data.append((tname, tval))
            else:
                form_data.append((name, value))

            if first_true_index is not None and i == first_true_index:
                for oname, ovalue in ownership_fields:
                    form_data.append((oname, ovalue))

        edit_url = f"{GB_BASE}/mods/edit/{self.mod_id}"
        logger.info("Submitting edit form (%d fields)", len(form_data))
        resp = self._request(
            "POST", edit_url,
            data=form_data,
            headers={
                "origin": GB_BASE,
                "referer": edit_url,
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "content-type": "application/x-www-form-urlencoded",
            },
            allow_redirects=True,
        )
        resp.raise_for_status()
        logger.info("Edit POST: status=%d url=%s", resp.status_code, resp.url)

        if "edit" in resp.url:
            raise RuntimeError(f"Edit form failed (still on edit URL: {resp.url})")
        logger.info("Edit submitted successfully: %s", resp.url)

    # ── deadlockmods.app sync ─────────────────────────────────────────────

    def notify_deadlockmods(self):
        url = f"https://api.deadlockmods.app/api/v2/sync/{self.mod_id}"
        try:
            resp = self._request("POST", url)
            logger.info("deadlockmods sync: status=%d body=%r", resp.status_code, resp.text[:200])
        except Exception:
            logger.warning("deadlockmods sync failed", exc_info=True)

    # ── Main entry ────────────────────────────────────────────────────────

    def publish(self, zip_path: Path, version: str):
        self.authenticate()
        self._submitter = self.get_submitter()

        html = self._get_edit_page()
        sdpid, files_json_name, image_json_name = self._get_upload_fields(html)

        upload = self.upload_zip(zip_path, sdpid)
        self.post_edit(upload, version, DESCRIPTION, files_json_name, image_json_name)

        logger.info("Waiting 30s for CDN/cache to settle...")
        time.sleep(30)
        self.notify_deadlockmods()
        logger.info("Done. Published version %s to GameBanana mod %d", version, self.mod_id)


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <zip_path> <version>")
        print("  e.g. python tools/gb_upload.py builds/Show-Nicknames-In-TopBar.zip 2026.07.02")
        sys.exit(1)

    zip_path = Path(sys.argv[1])
    version = sys.argv[2]

    if not zip_path.exists():
        print(f"Error: zip not found: {zip_path}")
        sys.exit(1)

    username = os.environ.get("GB_USERNAME")
    password = os.environ.get("GB_PASSWORD")
    if not username or not password:
        print("Error: GB_USERNAME and GB_PASSWORD env vars must be set")
        sys.exit(1)

    uploader = GameBananaUploader(username=username, password=password, mod_id=MOD_ID)
    uploader.publish(zip_path=zip_path, version=version)


if __name__ == "__main__":
    main()
