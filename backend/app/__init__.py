"""Single source of truth for the version.

Written here rather than read back from the installed distribution.
importlib.metadata reports what the .dist-info said at install time, and an
editable install writes that file only when it runs: the scripts run `pip install -e`
only when pyproject.toml changes, so a `git pull` that bumps the version alone would
leave /api/health reporting the version of the last install. Hatchling reads
this literal at build time, so pyproject.toml has no copy to drift from.
"""

__version__ = "3.0.1"
