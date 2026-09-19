use std::collections::HashMap;

#[derive(Debug, Default, PartialEq)]
pub struct ReconcileActions {
    /// Symbols that need a (re)started task: new symbols, and symbols
    /// whose frequency changed since they were last started.
    pub to_start: Vec<(String, f64)>,
    /// Symbols whose task should be stopped: no longer desired (or
    /// removed from config entirely).
    pub to_stop: Vec<String>,
}

/// Pure diff between what's currently running and what should be
/// running, given a symbol->frequency desired-state map. Kept free of
/// async/tokio so it can be unit-tested directly. Shared by the
/// market-data sampling supervisor and the decision-loop supervisor,
/// which both need identical start/stop/restart-on-frequency-change
/// scheduling logic against their own independent set of tasks.
pub fn reconcile(
    running: &HashMap<String, f64>,
    desired: &HashMap<String, f64>,
) -> ReconcileActions {
    let mut actions = ReconcileActions::default();

    for (symbol, frequency) in desired {
        match running.get(symbol) {
            None => actions.to_start.push((symbol.clone(), *frequency)),
            Some(running_frequency) if running_frequency != frequency => {
                actions.to_start.push((symbol.clone(), *frequency));
            }
            _ => {}
        }
    }

    for symbol in running.keys() {
        if !desired.contains_key(symbol) {
            actions.to_stop.push(symbol.clone());
        }
    }

    actions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_a_newly_desired_symbol() {
        let running = HashMap::new();
        let desired = HashMap::from([("BTC".to_string(), 60.0)]);

        let actions = reconcile(&running, &desired);
        assert_eq!(actions.to_start, vec![("BTC".to_string(), 60.0)]);
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn stops_a_symbol_no_longer_desired() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::new();

        let actions = reconcile(&running, &desired);
        assert!(actions.to_start.is_empty());
        assert_eq!(actions.to_stop, vec!["BTC".to_string()]);
    }

    #[test]
    fn restarts_a_symbol_whose_frequency_changed() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::from([("BTC".to_string(), 30.0)]);

        let actions = reconcile(&running, &desired);
        assert_eq!(actions.to_start, vec![("BTC".to_string(), 30.0)]);
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn leaves_an_unchanged_symbol_alone() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::from([("BTC".to_string(), 60.0)]);

        let actions = reconcile(&running, &desired);
        assert!(actions.to_start.is_empty());
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn handles_multiple_symbols_independently() {
        let running = HashMap::from([("BTC".to_string(), 60.0), ("ETH".to_string(), 30.0)]);
        let desired = HashMap::from([("BTC".to_string(), 60.0), ("SOL".to_string(), 15.0)]);

        let mut actions = reconcile(&running, &desired);
        actions.to_start.sort_by(|a, b| a.0.cmp(&b.0));
        actions.to_stop.sort();

        assert_eq!(actions.to_start, vec![("SOL".to_string(), 15.0)]);
        assert_eq!(actions.to_stop, vec!["ETH".to_string()]);
    }
}
