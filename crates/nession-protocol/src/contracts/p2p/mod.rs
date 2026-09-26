//! `p2p` contracts — see [`super`](self::super) for the layout rule.
//!
//! The credential that gates a direct Client → Agent connection.
//!
//! It exists because the peer-to-peer transport is a second door into the Agent
//! process, and until #1013 it was an unlocked one: the Server minted a token,
//! the Agent never checked it, and the socket behind it dispatches session
//! management and file operations as well as the terminal. The issuer is the
//! Server, the verifier is the Agent, and the unit here is how the record
//! travels between them.

pub mod v1;

/// The query parameter a P2P credential travels in.
///
/// **A family-level fact, which is why it is in `mod.rs` and not in `v1`.** The
/// parameter name is not versioned — a future `v2` credential would still be
/// presented as `token=` — so a versioned home would imply a coupling that does
/// not exist, and invite a duplicate on the day someone writes `v2`.
///
/// It lives in the protocol crate because it is the one part of this design
/// that three languages have to agree on and that nothing generates: the Web's
/// `buildAgentWsUrl`, the Server's relay dials and the CLI each write it by
/// hand. A rename in any one of them produces connections the Agent refuses
/// with an opaque handshake failure — the hardest failure in this design to
/// diagnose, and the reason the Rust half is a function rather than a literal
/// at each call site.
pub const CREDENTIAL_PARAM: &str = "token";

/// Put a P2P credential on an agent URL, or leave the URL alone.
///
/// **The Rust half of the convention above.** `nession-server` and
/// `nession-client` both dial an agent, and each had grown its own copy: they
/// were written days apart and already disagreed, the Server's appending
/// `token=` unconditionally where the client's treated an empty credential as
/// the absence of one. Two implementations of a shared wire convention that
/// have drifted once will drift again, so there is now one.
///
/// Three rules, each of which is a bug the other way round:
///
/// * **No credential adds no parameter.** `token=` with nothing after it would
///   make "no credential" and "the empty credential" the same bytes on the
///   wire, and only one of those is a thing that can exist.
/// * **A URL that already has a query gets `&`.** A second `?` makes the
///   credential part of the *previous* parameter's value, so it never arrives
///   and nothing at the far end can explain why.
/// * **A URL with no path gets one before the query.** `ws://host:port` is a
///   working agent URL — an absolute URI with an empty path implies `/` — and
///   `ws://host:port?token=x` is not: the request target becomes `?token=x`,
///   which is not origin-form, so the server drops the connection mid
///   handshake and the client reports an opaque `HandshakeIncomplete` with no
///   URL and no reason in it. Appending a query is what stops the path being
///   implied, so the `/` has to be written before the credential is.
/// * **The credential is percent-encoded.** Its alphabet is base64url today,
///   none of which needs encoding, so this is a no-op — but that is a property
///   of the current generator rather than of the parameter, and the far side
///   parses this through a URL decoder. An unencoded `+` would arrive as a
///   space and read as an unknown credential rather than as a malformed URL.
pub fn agent_url_with_credential(url: &str, credential: &str) -> String {
    if credential.is_empty() {
        return url.to_string();
    }
    let parameter = format!("{}={}", CREDENTIAL_PARAM, urlencode(credential));
    if url.contains('?') {
        return format!("{url}&{parameter}");
    }
    let separator = if is_authority_only(url) { "/?" } else { "?" };
    format!("{url}{separator}{parameter}")
}

/// Whether a URL is `scheme://authority` with nothing after it.
///
/// The three cases this separates are `ws://host:port` (no path),
/// `ws://host:port/ws` (a path) and `/ws` (relative, so no authority to speak
/// of). Only the first needs a `/` inserted, and it is the one a mock listener
/// produces, which is why the rule is easy to miss until a test uses one.
fn is_authority_only(url: &str) -> bool {
    let Some((_, rest)) = url.split_once("//") else {
        return false;
    };
    !rest.contains('/')
}

/// Read a credential back out of a URL query string.
///
/// The inverse of [`agent_url_with_credential`], and in the same module so the
/// two cannot drift: a change to what the writer escapes that the reader does
/// not follow is a credential that arrives subtly wrong, which the far end can
/// only report as "unknown token".
///
/// **`+` is a literal plus, not a space.** The usual form-urlencoded reading is
/// the other way round, and taking it would be wrong here for a reason that is
/// checkable rather than stylistic: [`urlencode`] percent-encodes `+`, and so
/// does the Web's `encodeURIComponent`, so no producer of this parameter ever
/// emits a bare `+` meaning a space. Decoding one as a space would therefore
/// never help a correct producer and would silently corrupt a credential that
/// legitimately contained one — and a credential is opaque here, so there is no
/// alphabet to appeal to.
///
/// Percent-decoding is byte-wise and lossy on invalid UTF-8: a malformed escape
/// yields `None` rather than a replacement character, because a credential that
/// decoded to something is a credential nobody issued and the refusal for it
/// should be "unknown", not "a near miss".
pub fn credential_from_query(query: &str) -> Option<String> {
    for pair in query.split('&') {
        // A parameter with no `=` is skipped rather than ending the search: the
        // credential is not required to be the first one, and a query this
        // function cannot read is a query it should keep looking in.
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == CREDENTIAL_PARAM {
            return percent_decode(value);
        }
    }
    None
}

/// Decode `%XX` escapes. `+` is left alone; see [`credential_from_query`].
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    // `get` rather than indexing throughout: an escape at the very end of the
    // input is the ordinary malformed case, and it should be `None` rather than
    // a panic inside a function whose whole job is to be suspicious of its
    // input.
    while let Some(byte) = bytes.get(index).copied() {
        if byte == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            decoded.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            decoded.push(byte);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// Percent-encode the characters a credential can contain and a URL cannot.
fn urlencode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests;
