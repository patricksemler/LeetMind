import os

from httpx import ASGITransport, AsyncClient

from leetmind.config import get_settings


async def test_health_reports_db_and_docker_up(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["db"] is True
    assert body["worker"] == "not_started"


async def test_health_reports_worker_started_when_enabled(pool):
    # `client`/`authed_client` disable the worker for test isolation (conftest.py); this checks
    # the other branch directly — the worker task just needs to exist, not to have done
    # anything, so no LLM/Docker access is required here.
    from leetmind.main import create_app

    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    os.environ["WORKER_ENABLED"] = "true"
    get_settings.cache_clear()
    app = create_app()
    try:
        async with app.router.lifespan_context(app):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://test") as ac:
                resp = await ac.get("/health")
    finally:
        del os.environ["WORKER_ENABLED"]
        get_settings.cache_clear()

    assert resp.status_code == 200
    assert resp.json()["worker"] == "ok"
