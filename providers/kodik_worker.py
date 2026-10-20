"""Isolated, time-limited parser process; token supplied only by the owner."""
import contextlib
import json
import os
import sys

def run(data):
    from anime_parsers_ru import KodikParser
    token = os.environ.get("KODIK_TOKEN", "")
    if not token:
        raise ValueError("Set KODIK_TOKEN to an API token issued to you by the provider.")
    parser = KodikParser(token=token, validate_token=True)
    action = data["action"]
    if action == "search":
        return parser.base_search(title=data["q"], limit=30, include_material_data=True).get("results", [])
    if action == "details":
        return parser.get_info(id=data["id"], id_type=data["id_type"])
    if action == "stream":
        # This library's documented stream method resolves season 1 only.
        if data.get("season", 1) != 1:
            raise ValueError("This adapter supports season 1 per release. Select a separate season release.")
        return parser.get_m3u8_playlist_link(id=data["id"], id_type=data["id_type"], seria_num=data["episode"], translation_id=data["translation"], quality=min(data["quality"], 720))
    raise ValueError("Unsupported parser action")

if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = run(json.loads(sys.stdin.read(10000)))
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    except Exception as exc:
        # Avoid disclosing credentials, URLs with tokens or provider traceback.
        print(json.dumps({"ok": False, "error": type(exc).__name__}))
