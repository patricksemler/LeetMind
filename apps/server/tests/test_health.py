async def test_health_reports_db_and_docker_up(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["db"] is True
    assert body["worker"] == "not_started"
