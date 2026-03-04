"""Silero VAD V5 — ONNX inference wrapper with auto-download."""

from __future__ import annotations

import os
import urllib.request

import numpy as np
import onnxruntime as ort

_MODEL_URL = (
    "https://github.com/snakers4/silero-vad/raw/refs/tags/v5.0/files/silero_vad.onnx"
)
_MODEL_DIR = os.path.join(os.path.dirname(__file__), "models")
_MODEL_PATH = os.path.join(_MODEL_DIR, "silero_vad.onnx")

# V5 constants
_CONTEXT_SIZE = 64  # samples prepended to each chunk
_CHUNK_SIZE = 512   # samples per inference
_STATE_SHAPE = (2, 1, 128)


def _ensure_model() -> str:
    """Download the Silero VAD ONNX model if not present."""
    if os.path.isfile(_MODEL_PATH):
        return _MODEL_PATH
    os.makedirs(_MODEL_DIR, exist_ok=True)
    print(f"Downloading Silero VAD model → {_MODEL_PATH} ...")
    urllib.request.urlretrieve(_MODEL_URL, _MODEL_PATH)
    print("Download complete.")
    return _MODEL_PATH


class SileroVAD:
    """Silero VAD V5 wrapper.

    Usage::

        vad = SileroVAD()
        prob = vad.process_chunk(chunk_512_samples)
        vad.reset()  # call before each new recording
    """

    def __init__(
        self,
        model_path: str | None = None,
        threshold: float = 0.5,
    ) -> None:
        path = model_path or _ensure_model()
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(path, sess_options=opts)
        self.threshold = threshold
        self._sr = np.array(16000, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        """Reset internal state and context buffer (call before each new recording)."""
        self._state = np.zeros(_STATE_SHAPE, dtype=np.float32)
        self._context = np.zeros(_CONTEXT_SIZE, dtype=np.float32)

    def process_chunk(self, chunk: np.ndarray) -> float:
        """Process exactly 512 float32 samples, return speech probability 0‥1."""
        if chunk.shape != (_CHUNK_SIZE,):
            raise ValueError(
                f"Expected ({_CHUNK_SIZE},) chunk, got {chunk.shape}"
            )
        # V5 input: context (64) + audio (512) = 576 samples, shape [1, 576]
        input_data = np.concatenate([self._context, chunk])[np.newaxis, :]
        ort_inputs = {
            "input": input_data,
            "state": self._state,
            "sr": self._sr,
        }
        output, new_state = self.session.run(["output", "stateN"], ort_inputs)
        self._state = new_state
        # Update context with the last 64 samples of this chunk
        self._context = chunk[-_CONTEXT_SIZE:].copy()
        return float(output[0, 0])
