-- docker-entrypoint-initdb.d runs this once, on first container init, against POSTGRES_DB.
-- The test suite needs a second, separately-truncatable database (see .env.example,
-- assert_test_database in db.py).
CREATE DATABASE leetmind_test;
