from voice_pipeline.store import CallStore


def test_registers_a_pending_call():
    store = CallStore(ttl_s=60)

    record = store.register("a", "Ship it?", "Tests pass.")

    assert record.status == "pending"
    assert record.prompt == "Context: Tests pass. Ship it?"
    assert store.get("a") is record


def test_refuses_a_duplicate_id():
    store = CallStore(ttl_s=60)
    store.register("a", "q", None)

    assert store.register("a", "other", None) is None


def test_first_terminal_transition_wins():
    store = CallStore(ttl_s=60)
    store.register("a", "q", None)

    assert store.answer("a", "yes")
    assert not store.fail("a", "Cancelled")
    assert not store.answer("a", "no")
    assert store.get("a").to_json() == {
        "callId": "a",
        "status": "answered",
        "answer": "yes",
    }


def test_failure_reports_its_error():
    store = CallStore(ttl_s=60)
    store.register("a", "q", None)

    store.fail("a", "No reply was heard")

    assert store.get("a").to_json() == {
        "callId": "a",
        "status": "failed",
        "error": "No reply was heard",
    }


def test_expired_calls_are_dropped_on_the_next_registration():
    store = CallStore(ttl_s=-1)
    store.register("a", "q", None)

    store.register("b", "q", None)

    assert store.get("a") is None
