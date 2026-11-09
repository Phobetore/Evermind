from app import __version__


async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["app"] == "evermind"


async def test_health_reports_the_running_version(client):
    """The version the code holds, not the one the last install recorded (see app/__init__.py)."""
    resp = await client.get("/api/health")
    assert resp.json()["version"] == __version__
    assert __version__ != "2.0.0", "the stale-version symptom is back"

