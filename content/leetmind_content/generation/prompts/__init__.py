"""Prompt builders for `leetmind_content.generation`, versioned by module (`v2.py` ->
`PROMPT_VERSION = "v2"`; future revisions get their own `v3.py` etc. rather than mutating `v2`
in place, so old `model_runs.prompt_version` values stay meaningful). An earlier `v1.py` (a
single-JSON-object prompt format) was retired and removed once nothing referenced it at runtime
— `model_runs.prompt_version = 'v1'` rows already in the database remain valid historical data;
removing the module does not change them, it just means that specific builder is no longer
inspectable by import."""
