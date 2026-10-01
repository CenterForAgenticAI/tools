use transition_session::{decide_transition, STATES};

fn main() {
    for from in STATES {
        for to in STATES {
            println!("{from}->{to} {}", decide_transition(from, to));
        }
    }
}
