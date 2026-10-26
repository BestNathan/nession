//! Bounded Control Mode record framing (#2300).
//!
//! One record is one line on the control stream — `%output`, a response-block
//! line, a notification — and the pane bytes it carries are **not UTF-8**:
//! `%output` escapes arbitrary bytes as octal and [`decode_tmux_output`]
//! decodes them, so framing works on raw bytes and never round-trips through
//! `String`.
//!
//! The framing lives beside the client because the client is its only
//! consumer. The session adapter above the client receives typed events, never
//! lines, and no longer carries a decoder of its own.
//!
//! [`decode_tmux_output`]: crate::parser::decode_tmux_output

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// A malformed or unbounded Control Mode line must never exhaust Agent memory.
pub(crate) const MAX_CONTROL_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Read one bounded Control Mode record as raw bytes (#2300).
///
/// Returns `Ok(0)` only when the stream ended between records. A stream that
/// ends **inside** a record is an error: treating the torn suffix as complete
/// would let an output frame cross the Agent stream boundary with bytes
/// missing.
pub(crate) async fn read_control_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<usize> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            // A line without its newline is NOT a protocol record.
            return if line.is_empty() {
                Ok(0)
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "tmux Control Mode stdout ended mid-record",
                ))
            };
        }
        let terminator = available.iter().position(|byte| *byte == b'\n');
        let take = terminator.map_or(available.len(), |index| index + 1);
        if take > MAX_CONTROL_LINE_BYTES.saturating_sub(line.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "tmux Control Mode line exceeds bounded frame limit",
            ));
        }
        let chunk = available.get(..take).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid tmux Control Mode frame length",
            )
        })?;
        line.extend_from_slice(chunk);
        reader.consume(take);
        if terminator.is_some() {
            return Ok(line.len());
        }
    }
}

/// Only unparseable records with a known protocol tag are fatal. Unknown
/// extension notifications remain forward compatible.
pub(crate) fn malformed_known_record(line: &[u8]) -> bool {
    const KNOWN: [&[u8]; 8] = [
        b"%output",
        b"%begin",
        b"%end",
        b"%error",
        b"%session-changed",
        b"%layout-change",
        b"%window-resize",
        b"%exit",
    ];
    KNOWN.iter().any(|prefix| {
        line == *prefix || (line.starts_with(prefix) && line.get(prefix.len()) == Some(&b' '))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncWriteExt, BufReader};

    #[tokio::test]
    async fn a_split_non_utf8_frame_is_preserved_byte_for_byte() {
        // The frame under test must be able to be written before the read
        // starts; the duplex's buffer is smaller than it, so the writer task
        // waits for the reader — which is what makes the split real.
        let (mut tx, rx) = duplex(5);
        let written = tokio::spawn(async move {
            tx.write_all(b"%output %0 a\xff\\033\n").await.unwrap();
        });
        let mut reader = BufReader::new(rx);
        let mut frame = Vec::new();
        assert!(read_control_line(&mut reader, &mut frame).await.unwrap() > 0);
        assert_eq!(frame, b"%output %0 a\xff\\033\n");
        written.await.unwrap();
    }

    #[tokio::test]
    async fn a_cancelled_read_keeps_its_prefix_until_the_newline() {
        let (mut tx, rx) = duplex(64);
        tx.write_all(b"%output %0 A").await.unwrap();
        let mut reader = BufReader::new(rx);
        let mut frame = Vec::new();

        // The read future is dropped mid-record (as any `select!` consumer may
        // do). The bytes it consumed must stay in `frame`, or the next read
        // would start inside the record and mis-deliver it.
        tokio::select! {
            biased;
            read = read_control_line(&mut reader, &mut frame) => {
                panic!("partial record should not finish: {read:?}");
            }
            () = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
        assert_eq!(frame, b"%output %0 A");
        tx.write_all(b"\\033\n").await.unwrap();
        assert_eq!(
            read_control_line(&mut reader, &mut frame).await.unwrap(),
            b"%output %0 A\\033\n".len()
        );
        assert_eq!(frame, b"%output %0 A\\033\n");
    }

    #[tokio::test]
    async fn a_truncated_record_is_a_frame_fault_not_a_shorter_record() {
        let (mut tx, rx) = duplex(16);
        tx.write_all(b"%output %0 A").await.unwrap();
        drop(tx);
        let mut reader = BufReader::new(rx);
        let err = read_control_line(&mut reader, &mut Vec::new())
            .await
            .expect_err("EOF before newline is a framing fault");
        assert_eq!(err.kind(), std::io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn only_an_unparseable_known_tag_is_fatal() {
        assert!(malformed_known_record(b"%output"));
        assert!(malformed_known_record(b"%begin not-a-triple"));
        assert!(
            !malformed_known_record(b"%new-tmux-feature foo"),
            "unknown notifications stay forward compatible"
        );
        assert!(
            !malformed_known_record(b"%outputx foo"),
            "a tag that merely starts with a known one is not that tag"
        );
    }
}
