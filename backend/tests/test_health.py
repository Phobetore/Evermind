from importlib.metadata import version


async def test_health(client):
    resp = await client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["app"] == "evermind"


async def test_health_reports_the_installed_version(client):
    """A released image once answered 2.0.0 because the number was copied into
    the handler by hand. Read it from the distribution and it cannot drift."""
    resp = await client.get("/api/health")
    assert resp.json()["version"] == version("evermind-backend")
