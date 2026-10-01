pub const STATES: [&str; 4] = ["idle", "working", "blocked", "not-running"];

pub fn decide_transition(from: &str, _to: &str) -> bool {
    from != "not-running"
}
