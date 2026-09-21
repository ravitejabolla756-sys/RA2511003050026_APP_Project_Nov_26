from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Request

from app.api import demo_media


def _request() -> Request:
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/demo-media/catalog",
        "headers": [(b"host", b"localhost:8000")],
        "query_string": b"",
    })


def test_catalog_lists_only_existing_allowlisted_demo_videos(tmp_path, monkeypatch):
    for name in ("anpr-vms-a.mp4", "vms-b.mp4", "not-a-demo.mp4"):
        (tmp_path / name).write_bytes(b"demo")
    monkeypatch.setattr(demo_media, "get_settings", lambda: SimpleNamespace(
        demo_mode=True,
        demo_media_dir=str(tmp_path),
    ))

    result = demo_media.demo_media_catalog(_request())

    assert [item["name"] for item in result["items"]] == ["vms-b.mp4"]
    assert result["items"][0]["source_url"] == "http://localhost:8000/demo-media/vms-b.mp4"
    assert result["items"][0]["tracks_url"].endswith("/vms-b.mp4/tracks")


def test_demo_catalog_is_disabled_when_demo_mode_is_off(tmp_path, monkeypatch):
    (tmp_path / "OP.mp4").write_bytes(b"demo")
    monkeypatch.setattr(demo_media, "get_settings", lambda: SimpleNamespace(
        demo_mode=False,
        demo_media_dir=str(tmp_path),
    ))

    assert demo_media.demo_media_catalog(_request()) == {"items": []}


def test_source_path_rejects_unlisted_or_traversal_names(tmp_path, monkeypatch):
    monkeypatch.setattr(demo_media, "get_settings", lambda: SimpleNamespace(
        demo_mode=True,
        demo_media_dir=str(tmp_path),
    ))

    with pytest.raises(HTTPException) as error:
        demo_media.source_path("../private.mp4")

    assert error.value.status_code == 404
