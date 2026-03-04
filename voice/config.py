"""Configuration loader — YAML file + environment variable overrides."""

from __future__ import annotations

import os
import yaml

_DEFAULTS = {
    "sample_rate": 16000,
    "channels": 1,
    "memoria_url": "http://127.0.0.1:3000",
    "admin_token": "",
    "tts_voice": "alloy",
    "vad_threshold": 0.5,
    "silence_duration": 0.8,
    "max_recording": 60,
    "wake_word": "hey memoria",
}

# Environment variable name → config key
_ENV_MAP = {
    "MEMORIA_URL": "memoria_url",
    "ADMIN_TOKEN": "admin_token",
    "TTS_VOICE": "tts_voice",
    "SAMPLE_RATE": "sample_rate",
    "CHANNELS": "channels",
    "VAD_THRESHOLD": "vad_threshold",
    "SILENCE_DURATION": "silence_duration",
    "MAX_RECORDING": "max_recording",
}


def load_config(path: str | None = None) -> dict:
    """Load config from YAML, fall back to defaults, apply env overrides."""
    cfg = dict(_DEFAULTS)

    yaml_path = path or os.path.join(os.path.dirname(__file__), "config.yaml")
    if os.path.isfile(yaml_path):
        with open(yaml_path, "r", encoding="utf-8") as f:
            from_file = yaml.safe_load(f) or {}
        cfg.update(from_file)

    # Environment variables take highest priority
    for env_key, cfg_key in _ENV_MAP.items():
        val = os.environ.get(env_key)
        if val is not None:
            # Coerce numeric values; skip bad input
            default = _DEFAULTS.get(cfg_key)
            try:
                if isinstance(default, int):
                    val = int(val)
                elif isinstance(default, float):
                    val = float(val)
            except ValueError:
                print(f"Warning: invalid {env_key}={val!r}, using default {default}")
                continue
            cfg[cfg_key] = val

    return cfg


cfg = load_config()
