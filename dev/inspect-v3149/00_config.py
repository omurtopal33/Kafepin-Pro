from __future__ import annotations

import json
import os
from pathlib import Path


APP_NAME = "KafePin Yazıcı PRO"
APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("LOCALAPPDATA", str(APP_DIR))) / "KafePinYaziciPRO"
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULTS = {
    "printer": "",
    "scanner_id": "",
    "dpi": 300,
    "color_mode": "color",
    "identity_layout": "side_by_side",
}


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    try:
        loaded = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cfg.update({key: loaded[key] for key in DEFAULTS if key in loaded})
    except Exception:
        pass
    return cfg


def save_config(cfg: dict) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    safe = {key: cfg.get(key, DEFAULTS[key]) for key in DEFAULTS}
    CONFIG_PATH.write_text(json.dumps(safe, ensure_ascii=False, indent=2), encoding="utf-8")
    return safe


def documents_dir() -> Path:
    path = Path.home() / "Documents" / "KafePin Belgeler"
    path.mkdir(parents=True, exist_ok=True)
    return path

