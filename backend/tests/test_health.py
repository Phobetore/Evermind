from app import __version__


async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["app"] == "evermind"


async def test_health_reports_the_running_version(client):
    """This has answered 2.0.0 twice, by two different routes. First the number
    was copied into the handler by hand. Then it was read from importlib
    .metadata, which reports what the .dist-info said at install time: the
    scripts only pip-install when the virtualenv is missing, so every source
    checkout froze on the version it was first set up with. The literal in
    app/__init__.py is what hatchling builds the distribution from, so
    reporting it reports the code that is actually running.
    """
    resp = await client.get("/api/health")
    assert resp.json()["version"] == __version__
    assert __version__ != "2.0.0", "the stale-version symptom is back"

