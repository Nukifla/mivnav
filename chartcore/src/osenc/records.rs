// chartcore — chart decode and tiling core for mivnav
// SPDX-License-Identifier: GPL-2.0-only

//! OSENC record framing and payload parsing.
//!
//! TLV stream: `u16 record_type`, `u32 record_length` (LE; length includes
//! the 6-byte header), then payload. `record_length == 0` or type above 200
//! (`SERVER_STATUS`) both end the stream — see docs/architecture/osenc-truncated-stream.md.

use std::io::{self, Read};

use super::OsencError;

/// Record type codes (`Osenc.h:34-64`).
pub mod rt {
    pub const HEADER_SENC_VERSION: u16 = 1;
    pub const HEADER_CELL_NAME: u16 = 2;
    pub const HEADER_CELL_PUBLISHDATE: u16 = 3;
    pub const HEADER_CELL_EDITION: u16 = 4;
    pub const HEADER_CELL_UPDATEDATE: u16 = 5;
    pub const HEADER_CELL_UPDATE: u16 = 6;
    pub const HEADER_CELL_NATIVESCALE: u16 = 7;
    pub const HEADER_CELL_SENCCREATEDATE: u16 = 8;
    pub const HEADER_CELL_SOUNDINGDATUM: u16 = 9;
    pub const FEATURE_ID: u16 = 64;
    pub const FEATURE_ATTRIBUTE: u16 = 65;
    pub const GEOMETRY_POINT: u16 = 80;
    pub const GEOMETRY_LINE: u16 = 81;
    pub const GEOMETRY_AREA: u16 = 82;
    pub const GEOMETRY_MULTIPOINT: u16 = 83;
    pub const GEOMETRY_AREA_EXT: u16 = 84;
    pub const EDGE_NODE_TABLE_EXT: u16 = 85;
    pub const CONNECTED_NODE_TABLE_EXT: u16 = 86;
    pub const EDGE_NODE_TABLE: u16 = 96;
    pub const CONNECTED_NODE_TABLE: u16 = 97;
    pub const CELL_COVR: u16 = 98;
    pub const CELL_NOCOVR: u16 = 99;
    pub const CELL_EXTENT: u16 = 100;
    pub const CELL_TXTDSC_INFO_FILE: u16 = 101;
    pub const SERVER_STATUS: u16 = 200;
}

const HEADER_SIZE: u32 = 6;
/// Cap on a single record payload — corrupt/hostile length fields must not
/// trigger huge allocations. Real OSENC records are far smaller (the
/// largest are sounding blocks and TXTDSC files).
const MAX_RECORD_PAYLOAD: u32 = 64 * 1024 * 1024;

/// One decoded TLV record.
pub struct Record {
    pub rtype: u16,
    pub payload: Vec<u8>,
}

/// Pull-based record reader over a byte stream.
pub struct RecordReader<R: Read> {
    input: R,
    done: bool,
}

impl<R: Read> RecordReader<R> {
    pub fn new(input: R) -> Self {
        RecordReader { input, done: false }
    }

    /// The next record, or `None` at end of stream — several conditions
    /// (torn header, truncated final payload, length 0, type >
    /// `SERVER_STATUS`) all count as clean EOF; see docs/architecture/osenc-truncated-stream.md.
    pub fn next_record(&mut self) -> Result<Option<Record>, OsencError> {
        if self.done {
            return Ok(None);
        }
        let mut header = [0u8; 6];
        match read_full(&mut self.input, &mut header)? {
            6 => {}
            _ => {
                // EOF at the boundary, or a torn trailing header: end
                self.done = true;
                return Ok(None);
            }
        }
        let rtype = u16::from_le_bytes([header[0], header[1]]);
        let length = u32::from_le_bytes([header[2], header[3], header[4], header[5]]);
        if length == 0 || rtype > rt::SERVER_STATUS {
            self.done = true;
            return Ok(None);
        }
        if length < HEADER_SIZE {
            return Err(OsencError::Format(format!(
                "record {rtype}: length {length} shorter than the 6-byte header"
            )));
        }
        let payload_len = length - HEADER_SIZE;
        if payload_len > MAX_RECORD_PAYLOAD {
            return Err(OsencError::Format(format!(
                "record {rtype}: implausible payload length {payload_len}"
            )));
        }
        let mut payload = vec![0u8; payload_len as usize];
        let got = read_full(&mut self.input, &mut payload)?;
        if got < payload.len() {
            // Truncated final record → clean EOF, not an error. See
            // docs/architecture/osenc-truncated-stream.md.
            self.done = true;
            return Ok(None);
        }
        Ok(Some(Record { rtype, payload }))
    }
}

/// Read as many bytes as available up to `buf.len()`, retrying short reads;
/// returns the byte count (< len only at EOF).
fn read_full<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<usize, OsencError> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(OsencError::Io(e)),
        }
    }
    Ok(filled)
}

/// Little-endian cursor over one record payload. All reads are
/// bounds-checked; running past the payload is a format error.
pub struct Payload<'a> {
    rtype: u16,
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Payload<'a> {
    pub fn new(record: &'a Record) -> Self {
        Payload {
            rtype: record.rtype,
            buf: &record.payload,
            pos: 0,
        }
    }

    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], OsencError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|&e| e <= self.buf.len())
            .ok_or_else(|| {
                OsencError::Format(format!(
                    "record {}: truncated reading {what} at offset {}",
                    self.rtype, self.pos
                ))
            })?;
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    pub fn u8(&mut self, what: &str) -> Result<u8, OsencError> {
        Ok(self.take(1, what)?[0])
    }
    pub fn u16(&mut self, what: &str) -> Result<u16, OsencError> {
        Ok(u16::from_le_bytes(self.take(2, what)?.try_into().unwrap()))
    }
    pub fn u32(&mut self, what: &str) -> Result<u32, OsencError> {
        Ok(u32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    pub fn i32(&mut self, what: &str) -> Result<i32, OsencError> {
        Ok(i32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    pub fn f32(&mut self, what: &str) -> Result<f32, OsencError> {
        Ok(f32::from_le_bytes(self.take(4, what)?.try_into().unwrap()))
    }
    pub fn f64(&mut self, what: &str) -> Result<f64, OsencError> {
        Ok(f64::from_le_bytes(self.take(8, what)?.try_into().unwrap()))
    }

    pub fn skip(&mut self, n: usize, what: &str) -> Result<(), OsencError> {
        self.take(n, what).map(|_| ())
    }

    /// Unread bytes left in the payload.
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }

    /// The rest of the payload as a NUL-trimmed string (lossy UTF-8).
    pub fn rest_str(&mut self) -> String {
        let s = &self.buf[self.pos.min(self.buf.len())..];
        self.pos = self.buf.len();
        let end = s.iter().position(|&b| b == 0).unwrap_or(s.len());
        String::from_utf8_lossy(&s[..end]).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(rtype: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&rtype.to_le_bytes());
        v.extend_from_slice(&((payload.len() as u32 + 6).to_le_bytes()));
        v.extend_from_slice(payload);
        v
    }

    #[test]
    fn reads_records_and_stops_cleanly() {
        let mut bytes = frame(1, &201u16.to_le_bytes());
        bytes.extend(frame(7, &12000u32.to_le_bytes()));
        let mut r = RecordReader::new(&bytes[..]);
        let a = r.next_record().unwrap().unwrap();
        assert_eq!((a.rtype, a.payload.len()), (1, 2));
        let b = r.next_record().unwrap().unwrap();
        assert_eq!((b.rtype, b.payload.len()), (7, 4));
        assert!(r.next_record().unwrap().is_none());
        assert!(r.next_record().unwrap().is_none()); // idempotent
    }

    #[test]
    fn zero_length_and_high_type_terminate() {
        // record_length == 0 → end
        let mut bytes = frame(1, &201u16.to_le_bytes());
        bytes.extend_from_slice(&64u16.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        let mut r = RecordReader::new(&bytes[..]);
        assert!(r.next_record().unwrap().is_some());
        assert!(r.next_record().unwrap().is_none());
        // type > 200 → treated as EOF, not an error
        let mut bytes = frame(999, b"junk");
        bytes[0..2].copy_from_slice(&999u16.to_le_bytes());
        let mut r = RecordReader::new(&bytes[..]);
        assert!(r.next_record().unwrap().is_none());
    }

    #[test]
    fn torn_trailing_header_is_eof() {
        // real daemon streams end with stray NUL bytes after the last
        // record; a torn trailing header must read as end-of-stream
        let mut bytes = frame(1, &201u16.to_le_bytes());
        bytes.extend_from_slice(&[0, 0]);
        let mut r = RecordReader::new(&bytes[..]);
        assert!(r.next_record().unwrap().is_some());
        assert!(r.next_record().unwrap().is_none());
    }

    #[test]
    fn truncated_final_payload_is_clean_eof() {
        // Reproduces the live bug: oexserverd emits a short stream for some
        // cells, ending mid-`GEOMETRY_AREA`. The reference keeps every
        // complete record and stops rather than failing the whole cell, so
        // an affected cell still renders. A complete record followed by one
        // whose payload is cut short must yield the first record, then a
        // clean end-of-stream — NOT an error.
        let mut bytes = frame(1, &201u16.to_le_bytes());
        let mut area = frame(rt::GEOMETRY_AREA, &[7u8; 40]);
        area.truncate(area.len() - 10); // cut the area record's payload short
        bytes.extend(area);
        let mut r = RecordReader::new(&bytes[..]);
        assert_eq!(r.next_record().unwrap().unwrap().rtype, 1);
        assert!(r.next_record().unwrap().is_none()); // truncated record → EOF
        assert!(r.next_record().unwrap().is_none()); // idempotent
    }

    #[test]
    fn length_below_header_errors() {
        // A declared length shorter than the 6-byte header is structural
        // corruption, not a ragged stream end — still a hard error.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&3u32.to_le_bytes());
        let mut r = RecordReader::new(&bytes[..]);
        assert!(matches!(r.next_record(), Err(OsencError::Format(_))));
    }

    #[test]
    fn payload_cursor() {
        let rec = Record {
            rtype: 65,
            payload: vec![1, 0, 4, b'a', b'b', 0, 9],
        };
        let mut p = Payload::new(&rec);
        assert_eq!(p.u16("code").unwrap(), 1);
        assert_eq!(p.u8("vt").unwrap(), 4);
        assert_eq!(p.rest_str(), "ab");
        let rec = Record {
            rtype: 1,
            payload: vec![0xc9, 0x00],
        };
        let mut p = Payload::new(&rec);
        assert_eq!(p.u16("version").unwrap(), 201);
        assert!(p.u8("past end").is_err());
    }
}
