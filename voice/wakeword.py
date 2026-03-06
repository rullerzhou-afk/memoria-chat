"""Wake word detection via sherpa-onnx keyword spotter (Chinese + English).

Auto-downloads the sherpa-onnx-kws-zipformer-zh-en-3M model on first use.
Keywords are specified as plain text in config and auto-tokenized at startup.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request

import numpy as np
import sounddevice as sd

_MODEL_DIR = os.path.join(os.path.dirname(__file__), "models", "kws-zh-en")
_MODEL_TAR_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
    "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2"
)
_MODEL_SUBDIR = "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20"

# Use int8 encoder + joiner for lower CPU usage; decoder stays fp32
_ENCODER = "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
_DECODER = "decoder-epoch-13-avg-2-chunk-16-left-64.onnx"
_JOINER = "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx"
_TOKENS = "tokens.txt"
_LEXICON = "en.phone"

_KEYWORDS_RAW = os.path.join(_MODEL_DIR, "keywords_raw.txt")
_KEYWORDS_FILE = os.path.join(_MODEL_DIR, "keywords.txt")

_SAMPLE_RATE = 16000
_CHUNK_DURATION = 0.1  # 100 ms per read
_SAMPLES_PER_READ = int(_CHUNK_DURATION * _SAMPLE_RATE)
_COOLDOWN_S = 1.0  # seconds to ignore after a detection


def _model_path(filename: str) -> str:
    return os.path.join(_MODEL_DIR, _MODEL_SUBDIR, filename)


def _ensure_model() -> None:
    """Download and extract the KWS model if not present."""
    if os.path.isfile(_model_path(_TOKENS)):
        return
    os.makedirs(_MODEL_DIR, exist_ok=True)
    tar_path = os.path.join(_MODEL_DIR, "model.tar.bz2")
    print(f"Downloading KWS model → {_MODEL_DIR} ...")
    urllib.request.urlretrieve(_MODEL_TAR_URL, tar_path)
    print("Extracting...")
    with tarfile.open(tar_path, "r:bz2") as tf:
        tf.extractall(_MODEL_DIR, filter="data")
    os.remove(tar_path)
    print("KWS model ready.")


def _generate_keywords(wake_words: list[str]) -> str:
    """Generate tokenized keywords.txt from plain-text wake words.

    Uses ``sherpa-onnx-cli text2token`` to convert Chinese/English text
    into the phonetic token format required by the keyword spotter.

    Returns the path to the generated keywords file.
    """
    # Write raw keywords file.
    # Format: "WORD1 WORD2 @word1_word2"
    # Words before @ are space-separated (for lexicon lookup).
    # English words must be UPPERCASE (CMU dict format in en.phone).
    # CJK characters are kept as-is (pinyin conversion handles them).
    # The @tag uses underscores (no spaces allowed in identifiers).
    with open(_KEYWORDS_RAW, "w", encoding="utf-8") as f:
        for word in wake_words:
            tag = word.replace(" ", "_")
            # Uppercase only ASCII letters (preserve CJK characters)
            lookup = ""
            for ch in word:
                lookup += ch.upper() if ch.isascii() else ch
            f.write(f"{lookup} @{tag}\n")

    # Run text2token via sherpa-onnx-cli (installed as console_scripts entry)
    base_args = [
        "--tokens", _model_path(_TOKENS),
        "--tokens-type", "phone+ppinyin",
        "--lexicon", _model_path(_LEXICON),
        _KEYWORDS_RAW,
        _KEYWORDS_FILE,
    ]
    # Try sherpa-onnx-cli first, then python -m fallback
    attempts = [
        ["sherpa-onnx-cli", "text2token"] + base_args,
        [sys.executable, "-m", "sherpa_onnx.cli", "text2token"] + base_args,
    ]
    last_err = None
    for cmd in attempts:
        try:
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True
            )
            return _KEYWORDS_FILE
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            last_err = exc
            continue

    raise RuntimeError(
        "Failed to tokenize keywords. Ensure sherpa-onnx is installed: "
        "pip install sherpa-onnx\n"
        f"Error: {last_err}"
    )


class WakeWordListener:
    """Background wake word listener using sherpa-onnx keyword spotter.

    Runs a sounddevice InputStream in a background thread, feeding audio
    to the keyword spotter.  When a keyword is detected, sets an
    asyncio.Event via ``loop.call_soon_threadsafe``.

    Usage::

        listener = WakeWordListener(wake_event, loop, wake_words=["你好小鹿"])
        listener.start()
        ...
        listener.pause()   # before VAD recording
        ...
        listener.resume()  # after VAD recording
        ...
        listener.stop()    # on shutdown
    """

    def __init__(
        self,
        wake_event: asyncio.Event,
        loop: asyncio.AbstractEventLoop,
        wake_words: list[str],
        keywords_threshold: float = 0.25,
        keywords_score: float = 1.0,
    ) -> None:
        import sherpa_onnx

        _ensure_model()
        keywords_file = _generate_keywords(wake_words)

        self._spotter = sherpa_onnx.KeywordSpotter(
            tokens=_model_path(_TOKENS),
            encoder=_model_path(_ENCODER),
            decoder=_model_path(_DECODER),
            joiner=_model_path(_JOINER),
            num_threads=1,
            max_active_paths=4,
            keywords_file=keywords_file,
            keywords_score=keywords_score,
            keywords_threshold=keywords_threshold,
            num_trailing_blanks=2,
            provider="cpu",
        )

        self._wake_event = wake_event
        self._loop = loop
        self._stream_obj = self._spotter.create_stream()

        self._running = False
        self._paused = threading.Event()
        self._paused.set()  # not paused initially
        self._stopped = threading.Event()
        self._stopped.set()
        self._thread: threading.Thread | None = None
        self._sd_stream: sd.InputStream | None = None
        self._last_detect: float = 0.0

    def start(self) -> None:
        """Start the background listener thread."""
        if self._running:
            return
        self._running = True
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._listen_loop, daemon=True, name="wakeword"
        )
        self._thread.start()

    def stop(self) -> None:
        """Stop the listener and wait for thread to finish."""
        self._running = False
        self._paused.set()  # unblock if paused
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None
        self._stopped.set()

    def pause(self, timeout: float = 2.0) -> None:
        """Pause listening (releases microphone).  Blocks until mic is closed."""
        if not self._running:
            return
        self._paused.clear()
        # Wait for the listen loop to actually close the stream
        deadline = time.monotonic() + timeout
        while self._sd_stream is not None and time.monotonic() < deadline:
            time.sleep(0.05)

    def resume(self) -> None:
        """Resume listening (re-opens microphone)."""
        if not self._running:
            return
        self._paused.set()

    def _listen_loop(self) -> None:
        """Background thread: open mic → feed spotter → detect → signal."""
        try:
            while self._running:
                # Wait if paused
                self._paused.wait()
                if not self._running:
                    break

                # Re-check pause flag before opening mic (avoid race with pause())
                if not self._paused.is_set():
                    continue

                # Open mic stream
                try:
                    self._sd_stream = sd.InputStream(
                        samplerate=_SAMPLE_RATE,
                        channels=1,
                        dtype="float32",
                        blocksize=_SAMPLES_PER_READ,
                    )
                    self._sd_stream.start()
                except Exception as exc:
                    print(f"[WakeWord] Mic open failed: {exc}")
                    time.sleep(1)
                    continue

                try:
                    self._read_loop()
                finally:
                    try:
                        self._sd_stream.stop()
                        self._sd_stream.close()
                    except Exception:
                        pass
                    self._sd_stream = None
        finally:
            self._stopped.set()

    def _read_loop(self) -> None:
        """Read chunks and run keyword detection until paused or stopped."""
        while self._running and self._paused.is_set():
            try:
                samples, _ = self._sd_stream.read(_SAMPLES_PER_READ)
            except Exception:
                break
            samples = samples.reshape(-1)
            self._stream_obj.accept_waveform(_SAMPLE_RATE, samples)

            while self._spotter.is_ready(self._stream_obj):
                self._spotter.decode_stream(self._stream_obj)

            result = self._spotter.get_result(self._stream_obj)
            if result:
                now = time.monotonic()
                if now - self._last_detect >= _COOLDOWN_S:
                    self._last_detect = now
                    keyword = result.strip()
                    print(f"[WakeWord] Detected: {keyword}")
                    try:
                        self._loop.call_soon_threadsafe(self._wake_event.set)
                    except RuntimeError:
                        # Loop closed during shutdown
                        return
                # Always reset after detection to avoid retrigger
                self._spotter.reset_stream(self._stream_obj)
