# SPDX-License-Identifier: GPL-3.0-or-later
"""Portable defaults and private output boundaries shared by all CLI commands."""
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = PROJECT/'outputs/hd-cursor'
DEFAULT_CHECKPOINT = PROJECT/'outputs/checkpoint'
DEFAULT_GESTURES = PROJECT/'outputs/inputs/gestures.json'


def output_directory(value):
    path = Path(value).resolve()
    roots = [(PROJECT/'outputs').resolve()]
    # Retain the enclosing Neverhood workspace's existing private asset location.
    workspace = PROJECT.parent.parent
    if (workspace/'package.json').is_file() and (workspace/'private-assets').is_dir():
        roots.append((workspace/'private-assets').resolve())
    if not any(path != root and path.is_relative_to(root) for root in roots):
        raise ValueError('Output must be a child of this project\'s outputs/ or the Neverhood private-assets/ directory')
    return path
