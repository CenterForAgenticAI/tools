STATES = ('idle', 'working', 'blocked', 'not-running')


def decide_transition(from_state, to_state):
    return from_state != 'not-running'
