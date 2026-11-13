# SPDX-License-Identifier: GPL-2.0-only
"""Licensed o-charts for the boat network only (mivnav.features.ocharts.network,
plan W11): the address classification and the forwarded-header trust rule.
The route side is in test_ocharts_devices."""

from __future__ import annotations

from ipaddress import ip_address

import pytest

from mivnav.features.ocharts.network import (
    boat_network_refusal,
    client_address,
    on_boat_network,
    parse_address,
)


@pytest.mark.parametrize(
    "addr",
    [
        "127.0.0.1", "127.8.9.10",
        "10.0.0.1", "10.255.255.255",
        "172.16.0.1", "172.31.255.254",
        "192.168.0.1", "192.168.255.254",
        "100.64.0.1", "100.127.255.254",
        "::1", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1",
    ],
)
def test_on_the_boat_network(addr: str) -> None:
    assert on_boat_network(ip_address(addr))


@pytest.mark.parametrize(
    "addr",
    [
        "8.8.8.8", "203.0.113.7", "172.15.255.255", "172.32.0.1", "192.169.0.1",
        "100.63.255.255", "100.128.0.1", "11.0.0.1", "169.254.1.1",
        "2001:db8::1", "2a00:1450::1", "fec0::1",
    ],
)
def test_off_the_boat_network(addr: str) -> None:
    assert not on_boat_network(ip_address(addr))


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("192.168.1.2", "192.168.1.2"),
        (" 192.168.1.2 ", "192.168.1.2"),
        ("192.168.1.2:5123", "192.168.1.2"),
        ("[fd00::1]", "fd00::1"),
        ("[fd00::1]:443", "fd00::1"),
        ("fe80::1%eth0", "fe80::1"),
        ("::ffff:203.0.113.7", "203.0.113.7"),  # dual-stack socket: its IPv4
        ("::ffff:10.0.0.1", "10.0.0.1"),
    ],
)
def test_parse_address(text: str, want: str) -> None:
    assert parse_address(text) == ip_address(want)


@pytest.mark.parametrize("text", [None, "", "testclient", "unknown", "[fd00::1", "1.2.3"])
def test_parse_address_rejects_non_addresses(text: str | None) -> None:
    assert parse_address(text) is None


def test_the_forwarded_header_is_trusted_from_loopback_only() -> None:
    lan, public = ip_address("192.168.1.30"), ip_address("203.0.113.7")
    # Behind the same-host proxy: its appended (rightmost) entry.
    assert client_address("127.0.0.1", "192.168.1.30") == lan
    assert client_address("::1", "203.0.113.7") == public
    assert client_address("127.0.0.1", "192.168.1.30, 203.0.113.7") == public
    assert client_address("127.0.0.1", "192.168.1.30,203.0.113.7,") == public
    # Loopback without a header: a client on this host.
    assert client_address("127.0.0.1", None) == ip_address("127.0.0.1")
    assert client_address("127.0.0.1", " , ") == ip_address("127.0.0.1")
    # Any other peer: its header is ignored, either way round.
    assert client_address("203.0.113.7", "192.168.1.30") == public
    assert client_address("192.168.1.30", "203.0.113.7") == lan
    # A Unix socket (no peer) is this host: its proxy's header counts.
    assert client_address(None, "203.0.113.7") == public
    assert client_address(None, None) == ip_address("127.0.0.1")


def test_what_cannot_be_told_is_refused() -> None:
    # Fails closed: a peer that is not an address (Starlette's TestClient
    # says "testclient"), or a proxy entry that is not one.
    assert client_address("testclient", None) is None
    assert boat_network_refusal("testclient", None) is not None
    assert boat_network_refusal("127.0.0.1", "unknown") is not None


def test_refusal_says_why() -> None:
    assert boat_network_refusal("192.168.1.30", None) is None
    assert boat_network_refusal("100.100.1.1", None) is None
    why = boat_network_refusal("127.0.0.1", "203.0.113.7")
    assert why is not None and "203.0.113.7" in why
