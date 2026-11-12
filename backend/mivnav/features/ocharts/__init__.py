# SPDX-License-Identifier: GPL-2.0-only
"""o-charts (oeSENC/OESU) support: encrypted chart sets served on demand,
ported from AvNav's ochartsng (GPLv2). Decoded cells live only in this
process's heap and the daemon→client pipe — never written to disk. Rendered
tiles of them are (the disk tile cache): encrypted under a
key bound to this machine's o-charts fingerprint, and opened only after a
startup licence check — see .disk_tiles and .licence."""
