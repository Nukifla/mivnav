// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! Protobuf-style base-128 varints and zigzag coding, shared by the MVT
//! encoder/decoder and the PMTiles directory format.

pub(crate) fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push((v as u8) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

/// `None` on truncation or a varint longer than 64 bits.
pub(crate) fn read_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *data.get(*pos)?;
        *pos += 1;
        v |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            return Some(v);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

pub(crate) fn zigzag_encode64(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

pub(crate) fn zigzag_decode64(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_round_trip() {
        for v in [
            0u64,
            1,
            127,
            128,
            300,
            16_383,
            16_384,
            u32::MAX as u64,
            u64::MAX,
        ] {
            let mut buf = Vec::new();
            write_varint(&mut buf, v);
            let mut pos = 0;
            assert_eq!(read_varint(&buf, &mut pos), Some(v));
            assert_eq!(pos, buf.len());
        }
    }

    #[test]
    fn varint_truncated_is_none() {
        let mut buf = Vec::new();
        write_varint(&mut buf, 300);
        let mut pos = 0;
        assert_eq!(read_varint(&buf[..1], &mut pos), None);
    }

    #[test]
    fn zigzag_round_trip() {
        for v in [0i64, 1, -1, 2, -2, i32::MAX as i64, i64::MIN, i64::MAX] {
            assert_eq!(zigzag_decode64(zigzag_encode64(v)), v);
        }
        // known values from the protobuf spec
        assert_eq!(zigzag_encode64(0), 0);
        assert_eq!(zigzag_encode64(-1), 1);
        assert_eq!(zigzag_encode64(1), 2);
        assert_eq!(zigzag_encode64(-2), 3);
    }
}
