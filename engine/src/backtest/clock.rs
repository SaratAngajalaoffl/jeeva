use std::sync::Mutex;

use chrono::{DateTime, Utc};

/// The simulated "now" for one backtest replay. `run_decision_cycle`'s
/// injected trait objects (history reader, decision log writer, funding
/// reader/writer) all read this instead of `Utc::now()`/`now()`, so
/// every row a backtest writes carries the timestamp being replayed,
/// not the wall-clock time the replay loop happens to run at.
pub struct SimClock {
    current: Mutex<DateTime<Utc>>,
}

impl SimClock {
    pub fn new(start: DateTime<Utc>) -> Self {
        Self {
            current: Mutex::new(start),
        }
    }

    pub fn set(&self, time: DateTime<Utc>) {
        *self.current.lock().unwrap() = time;
    }

    pub fn get(&self) -> DateTime<Utc> {
        *self.current.lock().unwrap()
    }
}
