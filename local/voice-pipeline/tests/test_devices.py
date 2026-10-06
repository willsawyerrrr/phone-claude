import json

import pytest

from voice_pipeline.devices import Device, DeviceStore, parse_device

TOKEN = "AB" * 32


def test_persists_and_reloads(tmp_path):
    path = tmp_path / "sub" / "device.json"
    DeviceStore(path).set(Device(TOKEN.lower(), "sandbox"))
    assert DeviceStore(path).get() == Device(TOKEN.lower(), "sandbox")
    assert list(path.parent.iterdir()) == [path]


def test_set_replaces_device(tmp_path):
    store = DeviceStore(tmp_path / "d.json")
    store.set(Device(TOKEN.lower(), "sandbox"))
    store.set(Device("cd" * 32, "production"))
    assert DeviceStore(tmp_path / "d.json").get() == Device("cd" * 32, "production")


def test_missing_file(tmp_path):
    assert DeviceStore(tmp_path / "none.json").get() is None


@pytest.mark.parametrize(
    "content", ["", "{", "[]", '{"token": 1}', '{"token": "zz", "environment": "x"}']
)
def test_corrupt_file(tmp_path, content):
    path = tmp_path / "d.json"
    path.write_text(content)
    store = DeviceStore(path)
    assert store.get() is None
    store.set(Device(TOKEN.lower(), "production"))
    assert json.loads(path.read_text())["environment"] == "production"


def test_clear_only_matching_token(tmp_path):
    path = tmp_path / "d.json"
    store = DeviceStore(path)
    store.set(Device(TOKEN.lower(), "sandbox"))
    store.clear("ff" * 32)
    assert store.get() is not None
    store.clear(TOKEN.lower())
    assert store.get() is None
    assert not path.exists()
    store.clear()


def test_token_is_lower_cased():
    assert parse_device(TOKEN, "sandbox").token == TOKEN.lower()


@pytest.mark.parametrize(
    "token", [None, 5, "", "ab" * 15, "ab" * 101, "a" * 33, "zz" * 32, "ab " * 21]
)
def test_invalid_token(token):
    with pytest.raises(ValueError):
        parse_device(token, "sandbox")


@pytest.mark.parametrize("environment", [None, "", "prod", "Sandbox"])
def test_invalid_environment(environment):
    with pytest.raises(ValueError):
        parse_device(TOKEN, environment)
