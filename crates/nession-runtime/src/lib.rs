//! The execution primitives the Server and the agent both run on (`#961-F`).
//!
//! Before this crate the same two things existed in three places at once. The
//! Server's `server::execution`, the agent's peer-to-peer `server::execution`
//! and the agent's central `connection::execution` each carried their own
//! `QueryLane`, their own `KeyedLane`, their own pair of snapshots and their
//! own `Lanes` — byte-for-byte identical apart from the log prefix and the
//! bounds, and kept in step by nothing at all.
//!
//! `#961-F` is where that gets settled, and its instruction is precise: do not
//! extract until two or more runtime paths have *shown* the same abstraction
//! holds, and do not unify what the evidence says is per-runtime. So the split
//! here is stated rather than implied:
//!
//! ## What is shared: the mechanism
//!
//! [`lane::QueryLane`] — bounded parallel, the reader waits for a slot — and
//! [`lane::KeyedLane`] — one worker per resource key, FIFO within a key,
//! independent across keys — are the same mechanism in all three runtimes, and
//! three independent implementations of them is three chances to get
//! "exactly-one-worker-per-key" subtly wrong. The parts that were *identical*
//! are the parts that are hardest to get right, which is why they transferred
//! unchanged from the first implementation to the second and the third:
//!
//! * the `worker: bool` flag and the queue live under one lock, so "whoever
//!   flips it is the one that spawns" is a fact rather than a race;
//! * the register-before-check for the `Notify`, so a queue that frees its last
//!   slot between the look and the await is not a lost wake-up;
//! * the **reader is what waits** — a frame that would exceed a bound is not
//!   read until there is room, which is the whole of "no per-message unbounded
//!   `tokio::spawn`";
//! * `drain` waits for the *workers* to stop, not merely for the queues to
//!   empty, which is what makes it a barrier;
//! * `shutdown` aborts, does not drain, and clears what was queued —
//!   see [`lane::KeyedLane::shutdown`].
//!
//! ## What is *not* shared: the policy
//!
//! Every number and every vocabulary word stays with the runtime that chose it,
//! and the call sites say so:
//!
//! | | Server | agent P2P | agent central |
//! |---|---|---|---|
//! | default for a frame the runtime does not serve | `Inline` | `Inline` | `Query` |
//! | ordered frames | auth, register, attach, relay | `client.auth` | none |
//! | key space | `Session`, `Env` | `Session`, `File` | `Session`, `Env` |
//! | query bound | config | 8 | 8 |
//! | per-key depth | 8 | 16 | 8 |
//! | global key-worker budget | none | none | 16 |
//!
//! Those are not variations on one answer — they are three answers, and the
//! requirement is explicit that a concurrency policy belongs to the runtime
//! that implements it. So the constructors take them as arguments
//! ([`lane::Lanes::new`], [`lane::Lanes::with_key_worker_budget`]) and no
//! default is invented here. The same goes for `ExecutionPolicy` itself, which
//! stays in each runtime: the variant sets differ (agent central has no
//! `Ordered`), the payloads it is read from differ, and there is no shared code
//! that pattern-matches on it to justify one enum.
//!
//! ## The label
//!
//! The one thing the three copies could not have shared is the runtime's name
//! in its own log lines. It is a parameter — `""` for the Server, which is what
//! makes its existing `query lane is full (…)` read exactly as it did.
//!
//! ## And the outbound path, the same way
//!
//! [`outbound`] is the other half of the same answer, and the one `#961-E`'s
//! abstraction verdict called the strongest candidate of all: the Server's write
//! path and the agent's peer-to-peer write path were the same bounded queue with
//! the same two bounds, the same three verdicts and the same
//! permit-released-by-the-writer discipline. Its *policies* — which lane waits,
//! which drops, which fails a request — stay with the two runtimes, and so do the
//! counters those policies are observed by.

pub mod lane;
pub mod outbound;
