from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'python'))
from session import STATES, decide_transition

for from_state in STATES:
    for to_state in STATES:
        print(f'{from_state}->{to_state} {str(decide_transition(from_state, to_state)).lower()}')
