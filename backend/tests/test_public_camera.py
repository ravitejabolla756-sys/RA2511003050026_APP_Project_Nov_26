from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api import public_camera


def test_public_camera_endpoint_is_disabled_outside_demo_mode(monkeypatch):
    monkeypatch.setattr(public_camera, "get_settings", lambda: SimpleNamespace(demo_mode=False))

    with pytest.raises(HTTPException) as error:
        public_camera._worker()

    assert error.value.status_code == 404


def test_public_camera_uses_configured_fixed_source_with_live_worker(monkeypatch):
    source_url = "http://frontend:3000/api/public-live-camera/playlist.m3u8"
    monkeypatch.setattr(public_camera, "get_settings", lambda: SimpleNamespace(
        demo_mode=True,
        public_live_camera_source_url=source_url,
    ))
    sentinel = object()
    calls = []

    def worker(source, camera_key, live=False):
        calls.append((source, camera_key, live))
        return sentinel

    monkeypatch.setattr(public_camera.preview_manager, "worker", worker)

    assert public_camera._worker() is sentinel
    assert calls == [(source_url, "public-iowa-i680", True)]
