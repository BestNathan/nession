//! The Claude TUI composer observation (#4665).
//!
//! `claude agents --json` reports *activity* — busy, waiting, idle — and is
//! blind to the input box: a composer full of unsubmitted text still observes
//! `idle`. Submitting into that state appends a second prompt to the first
//! (the "unchecked second submission" red line of #3779 SC-03), and submitting
//! before the TUI has drawn its input box at all loses the keys to startup.
//! The pane capture is the only place the composer's content can be seen, so
//! this module reads it.
//!
//! ## What the rendering facts are, and where they come from
//!
//! The shapes below were read from the Claude Code v2.1.332 bundle (the
//! version #4665 was observed on), not guessed:
//!
//! * the input box is a rounded-border box (`╭─╮ │ ╰─╯`) whose prompt line
//!   begins `> `;
//! * an **empty** composer shows either nothing after `> ` or a dimmed hint —
//!   `Try "<suggestion>"` on a fresh conversation, or another provider hint
//!   (`Message @…`, `Press up to edit queued messages`, …). Hints are rendered
//!   with the TUI's dim attribute; typed user text is not;
//! * unsent pastes appear as `[Pasted text #N +M lines]` (also `[Image #N]`,
//!   `[...Truncated text #N]`, `[✦ Team setup guide #N +M lines]`);
//! * input taller than the box shows `↑ N more above` / `↓ N more below`
//!   overflow indicators.
//!
//! ## The classification is fail-closed
//!
//! [`ComposerObservation::Ready`] is the only answer that permits sending, and
//! it requires *positive* evidence of an empty composer. Anything else —
//! unsubmitted text, a paste placeholder, an overflow indicator, a dialog, a
//! startup screen, an unrecognised layout — refuses. The two errors are not
//! symmetric: misreading an empty composer as dirty costs a refusal the caller
//! can inspect and retry; misreading a dirty composer as empty silently
//! concatenates prompts, which the delivery contract forbids. When the capture
//! cannot prove emptiness, it must not claim it.
//!
//! This is a TUI-evidence heuristic over a closed-source renderer: a future
//! Claude Code that changes its composer layout degrades to refusals, never to
//! a false `Ready`. The submission itself is proved separately, by transcript
//! read-back in the Agent's submit path — this observation only gates sending.

/// What the pane capture proves about the Claude input box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerObservation {
    /// The input box is present and holds no unsubmitted user text.
    Ready,
    /// The input box holds unsubmitted input; sending would append to it.
    /// The static string names the evidence, for the refusal detail.
    Dirty(&'static str),
    /// No recognisable input box: startup, a provider dialog, or a layout this
    /// version does not know. Input readiness is not established.
    NotRecognized,
}

/// Classify the Claude composer from a pane capture (escapes included, as
/// `capture-pane -e` emits them).
pub fn observe_composer(capture: &[u8]) -> ComposerObservation {
    let text = String::from_utf8_lossy(capture);
    let lines: Vec<Vec<Cell>> = text
        .split('\n')
        .map(|line| annotate(line.trim_end_matches('\r')))
        .collect();

    let Some(box_lines) = last_input_box(&lines) else {
        return ComposerObservation::NotRecognized;
    };

    // Unsent pastes and overflow indicators are dirty regardless of styling:
    // a paste placeholder is itself styled, and an overflow indicator means
    // there is more input than the box shows.
    for line in &box_lines {
        let body = plain(&content_body(line));
        if body.contains("[Pasted text")
            || body.contains("[Image #")
            || body.contains("[...Truncated text")
            || body.contains("Team setup guide #")
        {
            return ComposerObservation::Dirty("an unsent paste placeholder");
        }
        let trimmed = body.trim();
        if ((trimmed.starts_with('↑') || trimmed.starts_with('↓')) && trimmed.contains("more"))
            || (body.contains('✂') && body.contains("lines hidden"))
        {
            return ComposerObservation::Dirty("an input overflow indicator");
        }
    }

    // The prompt line is the first content line whose text begins with the
    // prompt glyph. Everything after the glyph is either empty, a dimmed
    // provider hint, or unsubmitted user text.
    let Some(prompt_index) = box_lines.iter().position(|line| {
        let body = plain(&content_body(line));
        let trimmed = body.trim_start();
        trimmed.starts_with("> ") || trimmed.starts_with('❯') || trimmed.trim_end() == ">"
    }) else {
        return ComposerObservation::NotRecognized;
    };

    for (index, line) in box_lines.iter().enumerate() {
        let body = content_body(line);
        if index == prompt_index {
            let run = prompt_text_run(&body);
            if run.is_empty() || run.iter().copied().all(Cell::hint_styled) {
                continue;
            }
            return ComposerObservation::Dirty("unsubmitted text in the input box");
        }
        // Continuation lines: wrapped or multi-line input. A dimmed line is a
        // wrapped provider hint; anything else is user content.
        let run: Vec<Cell> = body
            .iter()
            .copied()
            .filter(|cell| !cell.ch.is_whitespace())
            .collect();
        if run.is_empty() || run.iter().copied().all(Cell::hint_styled) {
            continue;
        }
        return ComposerObservation::Dirty("multi-line or wrapped input in the input box");
    }

    ComposerObservation::Ready
}

/// One printable character of a capture line, with the SGR state it was
/// rendered under. Escape sequences themselves are not content.
#[derive(Debug, Clone, Copy)]
struct Cell {
    ch: char,
    dim: bool,
    bright_black: bool,
}

impl Cell {
    /// Whether this character is rendered as a provider hint rather than user
    /// text: the TUI's dim attribute, or bright-black foreground. Typed input
    /// uses the theme's default foreground and is neither.
    fn hint_styled(self) -> bool {
        self.dim || self.bright_black
    }
}

/// The SGR state carried across one line. Only the attributes that separate
/// hints from user text are tracked; everything else is ignored.
#[derive(Debug, Clone, Copy, Default)]
struct Sgr {
    dim: bool,
    bright_black: bool,
}

impl Sgr {
    fn apply(&mut self, params: &[u16]) {
        // An empty parameter list is a reset (`ESC[m`).
        let params = if params.is_empty() { &[0] } else { params };
        let mut i = 0;
        while let Some(&param) = params.get(i) {
            match param {
                0 => *self = Self::default(),
                2 => self.dim = true,
                22 => self.dim = false,
                39 => self.bright_black = false,
                90 => self.bright_black = true,
                91..=97 | 30..=37 => self.bright_black = false,
                38 if params.get(i + 1) == Some(&5) => {
                    self.bright_black = params.get(i + 2) == Some(&8);
                    i += 2;
                }
                38 if params.get(i + 1) == Some(&2) => {
                    self.bright_black = false;
                    i += 4;
                }
                _ => {}
            }
            i += 1;
        }
    }
}

/// Project one capture line into its printable cells, tracking SGR state.
fn annotate(line: &str) -> Vec<Cell> {
    let mut cells = Vec::new();
    let mut sgr = Sgr::default();
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            if ch != '\r' {
                cells.push(Cell {
                    ch,
                    dim: sgr.dim,
                    bright_black: sgr.bright_black,
                });
            }
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                let mut params = Vec::new();
                let mut current: Option<u16> = None;
                let mut final_byte = None;
                for next in chars.by_ref() {
                    if next.is_ascii_digit() {
                        current = Some(
                            current
                                .unwrap_or(0)
                                .saturating_mul(10)
                                .saturating_add(next as u16 - '0' as u16),
                        );
                    } else if next == ';' {
                        params.push(current.unwrap_or(0));
                        current = None;
                    } else if ('\u{40}'..='\u{7e}').contains(&next) {
                        final_byte = Some(next);
                        break;
                    }
                }
                if final_byte == Some('m') {
                    params.push(current.unwrap_or(0));
                    sgr.apply(&params);
                }
            }
            Some(']') => {
                // OSC: consume until BEL or ST.
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {
                chars.next();
            }
        }
    }
    cells
}

fn plain(cells: &[Cell]) -> String {
    cells.iter().map(|cell| cell.ch).collect()
}

/// The content of one box line between its `│` borders, border padding
/// removed. Indices are cell positions, never byte offsets: the borders and
/// the content are multi-byte characters.
fn content_body(cells: &[Cell]) -> Vec<Cell> {
    let mut start = 0;
    while cells.get(start).is_some_and(|cell| cell.ch.is_whitespace()) {
        start += 1;
    }
    if cells.get(start).is_some_and(|cell| cell.ch == '│') {
        start += 1;
    }
    let mut end = cells.len();
    while end > start
        && cells
            .get(end - 1)
            .is_some_and(|cell| cell.ch.is_whitespace())
    {
        end -= 1;
    }
    if end > start && cells.get(end - 1).is_some_and(|cell| cell.ch == '│') {
        end -= 1;
    }
    while end > start
        && cells
            .get(end - 1)
            .is_some_and(|cell| cell.ch.is_whitespace())
    {
        end -= 1;
    }
    cells
        .get(start..end)
        .map(<[Cell]>::to_vec)
        .unwrap_or_default()
}

/// The text run after the prompt glyph on the prompt line. The glyph itself
/// and the space after it are not content.
fn prompt_text_run(body: &[Cell]) -> Vec<Cell> {
    let mut start = 0;
    while body.get(start).is_some_and(|cell| cell.ch.is_whitespace()) {
        start += 1;
    }
    if body
        .get(start)
        .is_some_and(|cell| cell.ch == '>' || cell.ch == '❯')
    {
        start += 1;
    }
    while body.get(start).is_some_and(|cell| cell.ch.is_whitespace()) {
        start += 1;
    }
    body.get(start..).map(<[Cell]>::to_vec).unwrap_or_default()
}

/// The content lines of the last rounded-border box in the capture — the
/// composer is drawn at the bottom of the screen, below any transcript box.
/// `None` when no complete box is present.
fn last_input_box(lines: &[Vec<Cell>]) -> Option<Vec<Vec<Cell>>> {
    let bottom = lines.iter().rposition(|line| {
        let plain = plain(line);
        plain.contains('╰') && plain.contains('╯')
    })?;
    let top = lines.get(..bottom)?.iter().rposition(|line| {
        let plain = plain(line);
        plain.contains('╭') && plain.contains('╮')
    })?;
    let content = lines.get(top + 1..bottom)?;
    if content.is_empty() {
        return None;
    }
    // Every line between the borders must be a box line: a content line (`│`)
    // or a tee border (`├`, the overflow cut). A stray line means this is not
    // the clean input-box shape.
    if content.iter().any(|line| {
        let first = plain(line).trim_start().chars().next();
        !matches!(first, Some('│') | Some('├'))
    }) {
        return None;
    }
    Some(content.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A capture line with the box borders and hint text dimmed, as the TUI
    /// renders them (`capture-pane -e` keeps the SGR).
    fn dim(s: &str) -> String {
        format!("\u{1b}[2m{s}\u{1b}[0m")
    }

    fn screen(lines: &[String]) -> Vec<u8> {
        lines.join("\n").into_bytes()
    }

    fn empty_box() -> Vec<String> {
        vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > {}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ]
    }

    #[test]
    fn an_empty_composer_is_ready() {
        assert_eq!(
            observe_composer(&screen(&empty_box())),
            ComposerObservation::Ready
        );
    }

    #[test]
    fn a_dimmed_try_hint_is_an_empty_composer() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!(
                "{} > {}{}",
                dim("│"),
                dim("Try \"fix lint errors\""),
                dim("│")
            ),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Ready
        );
    }

    #[test]
    fn a_bright_black_hint_is_also_an_empty_composer() {
        let lines = vec![
            "╭──────────────────────────────────────────╮".to_string(),
            "│ > \u{1b}[90mMessage @agent…\u{1b}[0m│".to_string(),
            "╰──────────────────────────────────────────╯".to_string(),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Ready
        );
    }

    #[test]
    fn typed_text_after_the_prompt_is_dirty() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > hello world{}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("unsubmitted text in the input box")
        );
    }

    #[test]
    fn a_long_cjk_prompt_is_dirty() {
        let prompt = "修复投递契约".repeat(60);
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > {prompt}{}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("unsubmitted text in the input box")
        );
    }

    #[test]
    fn text_that_starts_dim_but_resets_is_dirty() {
        // A hint-styled prefix must not vouch for the rest of the run: the
        // classification is per character, fail-closed.
        let lines = vec![
            "╭──────────────────────────────────────────╮".to_string(),
            "│ > \u{1b}[2mTry \"x\"\u{1b}[0m appended\u{1b}[2m│\u{1b}[0m".to_string(),
            "╰──────────────────────────────────────────╯".to_string(),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("unsubmitted text in the input box")
        );
    }

    #[test]
    fn an_unsent_paste_placeholder_is_dirty_even_though_styled() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!(
                "{} > {}{}",
                dim("│"),
                dim("[Pasted text #1 +22 lines]"),
                dim("│")
            ),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("an unsent paste placeholder")
        );
    }

    #[test]
    fn an_overflow_indicator_is_dirty() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > first line of a long prompt{}", dim("│"), dim("│")),
            format!("{} {}{}", dim("│"), dim("↑ 22 more above"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("an input overflow indicator")
        );
    }

    #[test]
    fn wrapped_continuation_lines_are_dirty() {
        // The first wrapped line already carries user text after the glyph,
        // so the prompt-line rule names the evidence.
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > first part of the prompt{}", dim("│"), dim("│")),
            format!("{} second part of the prompt{}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("unsubmitted text in the input box")
        );
    }

    #[test]
    fn a_non_dim_continuation_line_below_an_empty_prompt_is_dirty() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > {}", dim("│"), dim("│")),
            format!("{} unsubmitted continuation{}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("multi-line or wrapped input in the input box")
        );
    }

    #[test]
    fn a_startup_screen_without_an_input_box_is_not_recognized() {
        let lines = vec![
            "✻ Welcome to Claude Code".to_string(),
            "".to_string(),
            "  Starting up…".to_string(),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::NotRecognized
        );
    }

    #[test]
    fn a_box_without_a_prompt_line_is_not_recognized() {
        let lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!(
                "{} Do you trust the files in this folder?{}",
                dim("│"),
                dim("│")
            ),
            dim("╰──────────────────────────────────────────╯"),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::NotRecognized
        );
    }

    #[test]
    fn the_last_box_on_the_screen_is_the_composer() {
        let mut lines = vec![
            dim("╭──────────────────────────────────────────╮"),
            format!("{} > an older transcript box{}", dim("│"), dim("│")),
            dim("╰──────────────────────────────────────────╯"),
            "some transcript text".to_string(),
        ];
        lines.extend(empty_box());
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Ready
        );
    }

    #[test]
    fn an_empty_capture_is_not_recognized() {
        assert_eq!(observe_composer(b""), ComposerObservation::NotRecognized);
    }

    #[test]
    fn a_plain_unstyled_empty_box_is_ready() {
        // The structural shape alone proves an empty composer; the styling
        // only matters when there is text to classify.
        let lines = vec![
            "╭──────────────────────────────────────────╮".to_string(),
            "│ >                                        │".to_string(),
            "╰──────────────────────────────────────────╯".to_string(),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Ready
        );
    }

    #[test]
    fn the_alternate_prompt_glyph_is_recognized() {
        let lines = vec![
            "╭──────────────────────────────────────────╮".to_string(),
            "│ ❯ typed text                             │".to_string(),
            "╰──────────────────────────────────────────╯".to_string(),
        ];
        assert_eq!(
            observe_composer(&screen(&lines)),
            ComposerObservation::Dirty("unsubmitted text in the input box")
        );
    }
}
