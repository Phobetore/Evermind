"""Single source of truth for the version.

Read from the installed distribution rather than written here, so the number
reported by /api/health and the OpenAPI document cannot drift away from
pyproject.toml the way a copy does.
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _version

try:
    __version__ = _version("evermind-backend")
except PackageNotFoundError:  # a source tree that was never pip-installed
    __version__ = "0+unknown"
