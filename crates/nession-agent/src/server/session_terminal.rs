//! Session-scoped terminal control (#1095) and stream sequencing (#1094).

use std::collections::VecDeque;

use nession_protocol::contracts::terminal::v1::TerminalStreamEventPayload;

const DEFAULT_STREAM_EVENTS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalRole {
    Controller,
    Observer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionControlState {
    pub controller_client_id: Option<String>,
    pub generation: u64,
}

impl SessionControlState {
    pub fn new() -> Self {
        Self {
            controller_client_id: None,
            generation: 0,
        }
    }

    pub fn role_of(&self, client_id: &str) -> TerminalRole {
        if self.controller_client_id.as_deref() == Some(client_id) {
            TerminalRole::Controller
        } else {
            TerminalRole::Observer
        }
    }

    pub fn ensure_controller(&mut self, client_id: &str) -> u64 {
        if self.controller_client_id.is_none() {
            self.generation = self.generation.saturating_add(1);
            self.controller_client_id = Some(client_id.to_string());
        }
        self.generation
    }

    pub fn acquire(&mut self, client_id: &str) -> u64 {
        self.generation = self.generation.saturating_add(1);
        self.controller_client_id = Some(client_id.to_string());
        self.generation
    }

    pub fn release_if_holder(&mut self, client_id: &str) {
        if self.controller_client_id.as_deref() == Some(client_id) {
            self.controller_client_id = None;
        }
    }

    pub fn authorize_mutation(&self, client_id: &str, generation: Option<u64>) -> bool {
        if self.controller_client_id.as_deref() != Some(client_id) {
            return false;
        }
        match generation {
            Some(g) => g == self.generation,
            None => true,
        }
    }
}

impl Default for SessionControlState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct SessionStreamState {
    pub epoch: u64,
    next_seq: u64,
    events: VecDeque<TerminalStreamEventPayload>,
    max_events: usize,
}

impl SessionStreamState {
    pub fn new() -> Self {
        Self {
            epoch: 1,
            next_seq: 0,
            events: VecDeque::new(),
            max_events: DEFAULT_STREAM_EVENTS,
        }
    }

    pub fn cursor(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    pub fn record_output(&mut self, session_name: &str, data: String) -> (u64, u64) {
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let event = TerminalStreamEventPayload::Output {
            session_name: session_name.to_string(),
            stream_epoch: self.epoch,
            stream_seq: seq,
            data,
        };
        self.push_event(event);
        (self.epoch, seq)
    }

    pub fn record_resize(&mut self, session_name: &str, cols: u16, rows: u16) -> (u64, u64) {
        self.next_seq = self.next_seq.saturating_add(1);
        let seq = self.next_seq;
        let event = TerminalStreamEventPayload::Resize {
            session_name: session_name.to_string(),
            stream_epoch: self.epoch,
            stream_seq: seq,
            cols,
            rows,
        };
        self.push_event(event);
        (self.epoch, seq)
    }

    pub fn events_since(
        &self,
        epoch: u64,
        after_seq: u64,
    ) -> Option<Vec<TerminalStreamEventPayload>> {
        if epoch != self.epoch {
            return None;
        }
        Some(
            self.events
                .iter()
                .filter(|ev| stream_seq(ev) > after_seq)
                .cloned()
                .collect(),
        )
    }

    fn push_event(&mut self, event: TerminalStreamEventPayload) {
        if self.events.len() >= self.max_events {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
}

impl Default for SessionStreamState {
    fn default() -> Self {
        Self::new()
    }
}

fn stream_seq(ev: &TerminalStreamEventPayload) -> u64 {
    match ev {
        TerminalStreamEventPayload::Output { stream_seq, .. }
        | TerminalStreamEventPayload::Resize { stream_seq, .. } => *stream_seq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_client_becomes_controller_on_ensure() {
        let mut control = SessionControlState::new();
        let gen = control.ensure_controller("a");
        assert_eq!(gen, 1);
        assert_eq!(control.role_of("a"), TerminalRole::Controller);
        assert_eq!(control.role_of("b"), TerminalRole::Observer);
    }

    #[test]
    fn acquire_bumps_generation_and_rejects_stale() {
        let mut control = SessionControlState::new();
        control.ensure_controller("a");
        let g2 = control.acquire("b");
        assert_eq!(g2, 2);
        assert!(!control.authorize_mutation("a", Some(1)));
        assert!(control.authorize_mutation("b", Some(2)));
    }

    #[test]
    fn stream_records_monotonic_seq() {
        let mut stream = SessionStreamState::new();
        let (_, s1) = stream.record_output("s", "YQ==".to_string());
        let (_, s2) = stream.record_resize("s", 80, 24);
        assert_eq!(s1, 1);
        assert_eq!(s2, 2);
        let tail = stream.events_since(1, 0).expect("same epoch");
        assert_eq!(tail.len(), 2);
    }
}
