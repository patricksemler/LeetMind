"""Unit tests for the test-database-isolation guard itself (docs/CONTRACTS.md §13). This is a
safety device, so the rejection cases matter more than the acceptance cases — every one of them
must raise loudly, never silently continue. No live Postgres required.
"""

from __future__ import annotations

import pytest

# `leetmind_content.db` is imported as a module (not `from ... import test_database_url`)
# because pytest's default collection picks up any top-level callable named `test_*` in a test
# module's namespace — importing the function by name directly would make pytest try to collect
# `test_database_url` itself as a test case.
from leetmind_content import db as content_db


def _url_with_db(db_name: str) -> str:
    return f"postgres://leetmind:leetmind@localhost:5432/{db_name}"


# ---------------------------------------------------------------------------
# accepts
# ---------------------------------------------------------------------------


def test_accepts_database_named_exactly_test() -> None:
    content_db.assert_test_database(_url_with_db("test"))  # must not raise


def test_accepts_database_name_ending_in_underscore_test() -> None:
    content_db.assert_test_database(_url_with_db("leetmind_test"))  # must not raise


def test_accepts_database_name_ending_in_underscore_test_with_query_params() -> None:
    url = f"{_url_with_db('leetmind_test')}?sslmode=disable"
    content_db.assert_test_database(url)  # must not raise


# ---------------------------------------------------------------------------
# rejects — these matter more than the acceptance cases
# ---------------------------------------------------------------------------


def test_rejects_the_development_database_name() -> None:
    with pytest.raises(RuntimeError, match="refusing to run destructive"):
        content_db.assert_test_database(_url_with_db("leetmind"))


def test_rejects_a_name_that_merely_shares_a_prefix_with_leetmind() -> None:
    with pytest.raises(RuntimeError, match="refusing to run destructive"):
        content_db.assert_test_database(_url_with_db("leetmind_prod"))


def test_rejects_a_name_containing_test_but_not_as_a_suffix() -> None:
    with pytest.raises(RuntimeError, match="refusing to run destructive"):
        content_db.assert_test_database(_url_with_db("testing_db"))


def test_rejects_a_url_with_no_database_name_bare_host() -> None:
    with pytest.raises(RuntimeError, match="no database name"):
        content_db.assert_test_database("postgres://leetmind:leetmind@localhost:5432")


def test_rejects_a_url_with_no_database_name_trailing_slash() -> None:
    with pytest.raises(RuntimeError, match="no database name"):
        content_db.assert_test_database("postgres://leetmind:leetmind@localhost:5432/")


def test_rejects_a_malformed_connection_string() -> None:
    with pytest.raises(RuntimeError, match="malformed"):
        content_db.assert_test_database("not a url at all")


def test_rejects_an_empty_string() -> None:
    with pytest.raises(RuntimeError, match="malformed"):
        content_db.assert_test_database("")


# ---------------------------------------------------------------------------
# test_database_url()
# ---------------------------------------------------------------------------


def test_default_test_database_url_matches_contracts() -> None:
    assert content_db.DEFAULT_TEST_DATABASE_URL == "postgres://leetmind:leetmind@localhost:5432/leetmind_test"


def test_resolving_test_database_url_falls_back_to_default_when_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    assert content_db.test_database_url() == content_db.DEFAULT_TEST_DATABASE_URL


def test_resolving_test_database_url_reads_env_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEST_DATABASE_URL", "postgres://leetmind:leetmind@localhost:5432/leetmind_test")
    assert content_db.test_database_url() == "postgres://leetmind:leetmind@localhost:5432/leetmind_test"
