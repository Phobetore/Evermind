"""Single source of truth for the version.

Written here rather than read back from the installed distribution.
importlib.metadata reports what the .dist-info said at install time, and an
editable install writes that file once: the scripts only run `pip install -e`
when the virtualenv is missing, so every later `git pull` left /api/health
reporting whatever version the machine was first set up with. Hatchling reads
this literal at build time, so pyproject.toml has no copy to drift from.
"""

__version__ = "2.0.7"
