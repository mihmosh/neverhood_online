"""Shared input identity; no model runtime or game decoding dependencies."""

import hashlib
import struct

NAMESPACE = b"neverhood-realesrnet-embedded-v1\0"
MODEL_SHA256 = "a820b9bde89a874d7599d545567308ce6c128fc8754a53208eda016d40aa81df"
PREPROC_SPEC = "foreground-nearest+reflect8+float32+alpha0-sourcebinary4x"
MAX_PACK_BYTES = 32 * 1024 * 1024


def job_key(width, height, rgba):
    """Hash dimensions and straight RGBA8, binary alpha, hidden RGB normalized zero.

    No flip canonicalization. Foreground fill and reflect padding are worker-only.
    Fully transparent inputs remain jobs; workers may emit zero RGBA at 4x directly.
    """
    if width <= 0 or height <= 0 or len(rgba) != width * height * 4:
        raise ValueError("Invalid RGBA dimensions")
    return hashlib.sha256(
        NAMESPACE + MODEL_SHA256.encode("ascii") + b"\0"
        + PREPROC_SPEC.encode("ascii") + b"\0"
        + struct.pack("<II", width, height) + rgba
    ).hexdigest()


def keyset_digest(keys):
    """SSM contract: SHA256(sorted unique ASCII job keys, each ending LF)."""
    return hashlib.sha256("".join(key + "\n" for key in sorted(set(keys))).encode("ascii")).hexdigest()
