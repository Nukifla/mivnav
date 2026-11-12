# SPDX-License-Identifier: GPL-2.0-only
"""Shop client against mocked o-charts.org responses (formats per
ochartsng's ShopLogin.js / ShopRequestHandler.h)."""

from urllib.parse import parse_qs

import httpx
import pytest

from mivnav.features.ocharts.shop import (
    Credentials,
    ShopClient,
    ShopError,
    load_credentials,
)

CREDS = Credentials(user="sailor@example.com", password="hunter2!")

# shape observed live 2026-07 + the reference's slot nesting
GETLIST_XML = """<?xml version="1.0" encoding="utf-8"?>
<response>
  <result>1</result>
  <systemName>boatpc</systemName>
  <chart>
    <order>PXZKCZPTB</order>
    <chartId>OC77</chartId>
    <chartName>Denmark 2026</chartName>
    <edition>2026/01-1</edition>
    <expired>0</expired>
    <maxSlots>5</maxSlots>
    <quantity>
      <quantityId>1</quantityId>
      <slot><slotUuid>slot-1</slotUuid><assignedSystemName>boatpc</assignedSystemName></slot>
      <slot><slotUuid>slot-2</slotUuid><assignedSystemName></assignedSystemName></slot>
      <slot></slot>
    </quantity>
  </chart>
  <chart>
    <order>OTHERORD</order>
    <chartId>OC88</chartId>
    <chartName>Expired Set</chartName>
    <edition>2020/01-1</edition>
    <expired>1</expired>
    <quantity><quantityId>1</quantityId></quantity>
  </chart>
</response>
"""


def make_client(handler) -> ShopClient:
    transport = httpx.MockTransport(handler)
    return ShopClient(CREDS, http=httpx.Client(transport=transport))


def form(request: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(request.content.decode()).items()}


def xml_response(body: str) -> httpx.Response:
    return httpx.Response(200, text=body, headers={"content-type": "text/xml"})


def test_login_sends_hex_password_and_extracts_key() -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(form(request))
        return xml_response(
            "<response><result>1</result><key>8300da1466cdb5487e83536dfcd23bb3</key></response>"
        )

    client = make_client(handler)
    client.login()
    assert seen["taskId"] == "login2"
    assert seen["username"] == CREDS.user
    assert seen["password"] == CREDS.password.encode().hex()
    assert seen["password"] != CREDS.password


def test_shop_error_code_is_translated() -> None:
    client = make_client(
        lambda r: xml_response("<response><result>6</result></response>")
    )
    with pytest.raises(ShopError) as e:
        client.login()
    assert "invalid user/email name or password" in str(e.value)
    assert e.value.code == "6"


def test_identify_unregistered_returns_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        params = form(request)
        if params["taskId"] == "login2":
            return xml_response("<response><result>1</result><key>k</key></response>")
        assert params["taskId"] == "identifySystem"
        assert params["xfprName"] == "host.fpr"
        assert params["xfpr"] == "aabbcc"
        return xml_response("<response><result>8l</result></response>")

    client = make_client(handler)
    assert client.identify_system("host.fpr", "aabbcc") is None


def test_identify_registered_returns_system_name() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if form(request)["taskId"] == "login2":
            return xml_response("<response><result>1</result><key>k</key></response>")
        return xml_response(
            "<response><result>1</result><systemName>boatpc</systemName></response>"
        )

    client = make_client(handler)
    assert client.identify_system("host.fpr", "aabbcc") == "boatpc"


def test_chart_list_parses_slots_and_expiry() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if form(request)["taskId"] == "login2":
            return xml_response("<response><result>1</result><key>k</key></response>")
        return xml_response(GETLIST_XML)

    client = make_client(handler)
    systems, charts = client.chart_list()
    assert systems == ["boatpc"]
    assert len(charts) == 2
    dk = charts[0]
    assert (dk.chart_id, dk.name, dk.edition, dk.expired) == (
        "OC77",
        "Denmark 2026",
        "2026/01-1",
        False,
    )
    assert (dk.order, dk.quantity_id) == ("PXZKCZPTB", "1")
    # empty <slot/> elements (reference shows they occur) are dropped
    assert [(s.slot_uuid, s.assigned_system) for s in dk.slots] == [
        ("slot-1", "boatpc"),
        ("slot-2", None),
    ]
    assert charts[1].expired is True
    assert charts[1].slots == []


def test_assign_returns_slot_uuid() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        params = form(request)
        if params["taskId"] == "login2":
            return xml_response("<response><result>1</result><key>k</key></response>")
        assert params["taskId"] == "assign"
        assert params["order"] == "PXZKCZPTB"
        assert params["chartid"] == "OC77"
        assert params["quantityId"] == "1"
        assert params["systemName"] == "boatpc"
        return xml_response(
            "<response><result>1</result><chart><quantity><quantityId>1</quantityId>"
            "<slot><slotUuid>new-slot-uuid</slotUuid>"
            "<assignedSystemName>boatpc</assignedSystemName></slot>"
            "</quantity></chart></response>"
        )

    client = make_client(handler)
    assert client.assign_chart("PXZKCZPTB", "OC77", "1", "boatpc") == "new-slot-uuid"


def test_download_urls() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        params = form(request)
        if params["taskId"] == "login2":
            return xml_response("<response><result>1</result><key>k</key></response>")
        assert params["taskId"] == "request"
        assert params["requestedFile"] == "base"
        assert params["assignedSystemName"] == "boatpc"
        assert params["slotUuid"] == "slot-1"
        return xml_response(
            "<response><result>1</result><file>"
            "<link>https://dl.example/charts.zip</link>"
            "<chartKeysLink>https://dl.example/keys.xml</chartKeysLink>"
            "</file></response>"
        )

    client = make_client(handler)
    urls = client.download_urls("boatpc", "slot-1", "2026/01-1")
    assert urls.chart_url == "https://dl.example/charts.zip"
    assert urls.key_url == "https://dl.example/keys.xml"


def test_errors_never_leak_credentials() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            f"cannot reach host (context: {CREDS.password} {CREDS.user})"
        )

    client = make_client(handler)
    with pytest.raises(ShopError) as e:
        client.login()
    text = str(e.value)
    assert CREDS.password not in text
    assert CREDS.user not in text
    assert "[redacted]" in text


def test_load_credentials_env_file(tmp_path) -> None:
    env = tmp_path / "ocharts.env"
    env.write_text("# comment\nOCHARTS_USER=me@example.com\nOCHARTS_PASSWORD='p w'\n")
    creds = load_credentials(env)
    assert creds == Credentials(user="me@example.com", password="p w")
    assert load_credentials(tmp_path / "missing.env") is None
    env.write_text("OCHARTS_USER=only-user\n")
    assert load_credentials(env) is None
