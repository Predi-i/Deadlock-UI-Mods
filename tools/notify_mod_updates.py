"""Send text-only UI Mods developer notifications with restricted role mentions."""
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = "DiscordBot (https://github.com/Predi-i/Deadlock-UI-Mods, 1.0)"


def request_json(url, payload=None):
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Discord rejected the notification (HTTP {error.code}); it remains unacknowledged") from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError("Discord delivery could not be acknowledged") from None


def send(content):
    webhook = os.environ.get("DISCORD_WEBHOOK_URL", "")
    channel = os.environ.get("DISCORD_CHANNEL_ID", "")
    role = os.environ.get("DISCORD_ROLE_ID", "")
    if not webhook:
        print("UI Mods developer webhook is not configured; review links remain available on GitHub.")
        return False
    if not re.fullmatch(r"\d{17,20}", channel) or not re.fullmatch(r"\d{17,20}", role):
        raise ValueError("Configure the UI Mods Discord channel and role IDs")
    parsed = urllib.parse.urlsplit(webhook)
    if parsed.scheme != "https" or parsed.hostname not in ("discord.com", "discordapp.com"):
        raise ValueError("Expected a Discord HTTPS webhook")
    if request_json(webhook).get("channel_id") != channel:
        raise ValueError("Webhook does not belong to the configured UI Mods channel")
    payload = {"content": f"<@&{role}> " + content[:1850],
               "allowed_mentions": {"parse": [], "roles": [role]}}
    query = [(key, value) for key, value in urllib.parse.parse_qsl(parsed.query) if key != "wait"] + [("wait", "true")]
    message = request_json(urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query))), payload)
    if message.get("channel_id") != channel or not message.get("id"):
        raise ValueError("Discord did not acknowledge delivery to the UI Mods channel")
    return True


def native(directory):
    summary = json.loads((directory / "summary.json").read_text(encoding="utf-8"))
    if not summary["changed"] or not (directory / "pr-url.txt").is_file():
        return False
    url = (directory / "pr-url.txt").read_text().strip()
    mods = sorted({item["path"].split("/")[0] for item in summary["changes"]})
    content = "Deadlock native resources changed.\n" + url + "\nMods: " + ", ".join(mods)
    if summary["blocked_mods"]:
        content += "\nManual fixes required: " + ", ".join(summary["blocked_mods"])
    content += "\nReview XML and verify the compiled mods in game before publication."
    return send(content)


if __name__ == "__main__":
    if native(Path(".upstream-review")) and os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as outputs:
            outputs.write("sent=true\n")
