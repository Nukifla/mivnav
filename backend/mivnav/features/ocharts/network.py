# SPDX-License-Identifier: GPL-2.0-only
"""Licensed o-charts content for the boat network only (o-charts policy:
no web services for third parties; docs/ocharts-licence-compliance-plan.md,
W11).

The backend binds :8230 on the Pi, usually behind a user-managed HTTPS
reverse proxy on the same host (deploy/mivnav.service). An accidental port
forward or ``tailscale funnel`` must not turn it into a public o-charts
server, so licensed content is refused to any client address outside the
boat LAN (loopback, RFC 1918, IPv6 ULA/link-local) and the tailnet
(100.64.0.0/10).

Who the client is: the direct TCP peer, except when that peer is loopback —
then it is the same-host reverse proxy, and the client is the rightmost
``X-Forwarded-For`` entry (the one that proxy appended; anything left of it
is whatever the client chose to send). A forwarded header from any other
peer is ignored: only the proxy on this host is trusted to set it.

Framework-free on purpose: callers pass the peer host and the header.
"""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network

IPAddress = IPv4Address | IPv6Address

#: The boat network: LAN, this host, and the tailnet.
BOAT_NETWORKS = tuple(
    ip_network(n)
    for n in (
        "127.0.0.0/8",  # loopback
        "10.0.0.0/8",  # RFC 1918
        "172.16.0.0/12",  # RFC 1918
        "192.168.0.0/16",  # RFC 1918
        "100.64.0.0/10",  # tailscale (CGNAT range)
        "::1/128",  # IPv6 loopback
        "fc00::/7",  # IPv6 ULA (tailscale's fd7a:115c:a1e0::/48 included)
        "fe80::/10",  # IPv6 link-local
    )
)


def parse_address(text: str | None) -> IPAddress | None:
    """An address as a proxy or server writes it — bare, ``v4:port``,
    ``[v6]`` or ``[v6]:port`` — or None if it is not one. An IPv4-mapped
    IPv6 address (a dual-stack socket's ``::ffff:a.b.c.d``) is its IPv4
    address."""
    if text is None:
        return None
    s = text.strip()
    if s.startswith("["):
        s = s[1 : s.find("]")] if "]" in s else ""
    elif s.count(":") == 1:
        s = s.split(":", 1)[0]
    s = s.split("%", 1)[0]  # an IPv6 zone id
    try:
        addr = ip_address(s)
    except ValueError:
        return None
    if isinstance(addr, IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def on_boat_network(addr: IPAddress) -> bool:
    return any(addr.version == n.version and addr in n for n in BOAT_NETWORKS)


def client_address(peer: str | None, forwarded_for: str | None) -> IPAddress | None:
    """The client a request is from (see the module doc), or None if that
    cannot be told — which the caller must treat as off the boat network.

    ``peer`` None is a Unix-socket connection (the ASGI scope has no client):
    only something on this host can open it, so it counts as loopback.
    ``forwarded_for`` is every ``X-Forwarded-For`` header joined with ``,``."""
    if peer is None:
        direct: IPAddress | None = IPv4Address("127.0.0.1")
    else:
        direct = parse_address(peer)
        if direct is None:
            return None
    if not direct.is_loopback or not forwarded_for:
        return direct
    entries = [e for e in (p.strip() for p in forwarded_for.split(",")) if e]
    if not entries:
        return direct
    return parse_address(entries[-1])


def boat_network_refusal(peer: str | None, forwarded_for: str | None) -> str | None:
    """None if this request comes from the boat network, else why not."""
    addr = client_address(peer, forwarded_for)
    if addr is None:
        return f"cannot tell the client address (peer {peer!r})"
    if not on_boat_network(addr):
        return f"{addr} is not on the boat network"
    return None


__all__ = [
    "BOAT_NETWORKS",
    "boat_network_refusal",
    "client_address",
    "on_boat_network",
    "parse_address",
]
