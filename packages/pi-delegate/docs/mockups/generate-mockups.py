#!/usr/bin/env python3
"""Generate docs/mockups/delegate-tui-mockups.html for the pi-delegate overlay redesign.

Terminal frames are built programmatically so column alignment is exact.
Inline markup:  «class|text»  ->  <span class="class">text</span>
"""
import html
import re
import sys
import unicodedata

TOKEN = re.compile(r"«([a-zA-Z0-9 _-]*)\||»")


def cell_width(text: str) -> int:
    """Terminal cells a plain string occupies.

    Only East-Asian Wide/Fullwidth code points take two cells. The box-drawing
    and arrow glyphs used here are Ambiguous, which every terminal font in use
    renders single-width.
    """
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def _walk(s: str):
    """Yield (class_stack, literal_text) for a markup string, honouring nesting."""
    stack: list[str] = []
    pos = 0
    for m in TOKEN.finditer(s):
        if m.start() > pos:
            yield list(stack), s[pos:m.start()]
        if m.group(0) == "»":
            if stack:
                stack.pop()
        else:
            stack.append(m.group(1))
        pos = m.end()
    if pos < len(s):
        yield list(stack), s[pos:]


def vis(s: str) -> int:
    """Visible terminal width of a markup string."""
    return sum(cell_width(text) for _, text in _walk(s))


def emit(s: str) -> str:
    """Markup -> HTML. Nested spans are preserved; literal text is escaped."""
    out = []
    for classes, text in _walk(s):
        esc = html.escape(text)
        for cls in reversed([c for c in classes if c]):
            esc = f'<span class="{cls}">{esc}</span>'
        out.append(esc)
    return "".join(out)


def pad(s: str, w: int) -> str:
    return s + " " * max(0, w - vis(s))



class Frame:
    """A bordered terminal panel with an optional two-pane body."""

    def __init__(self, inner: int, left: int | None = None):
        self.inner = inner
        self.left = left
        self.right = None if left is None else inner - left - 1
        self.lines: list[str] = []

    # ---- chrome -------------------------------------------------------
    def top(self, title: str = "") -> "Frame":
        if title:
            t = f"«bd|─» {title} "
            fill = self.inner - vis(t)
            self.lines.append("«bd|╭»" + t + "«bd|" + "─" * max(0, fill) + "»" + "«bd|╮»")
        else:
            self.lines.append("«bd|╭" + "─" * self.inner + "╮»")
        return self

    def bottom(self) -> "Frame":
        self.lines.append("«bd|╰" + "─" * self.inner + "╯»")
        return self

    def rule(self) -> "Frame":
        self.lines.append("«bd|├" + "─" * self.inner + "┤»")
        return self

    def split_open(self) -> "Frame":
        self.lines.append("«bd|├" + "─" * self.left + "┬" + "─" * self.right + "┤»")
        return self

    def split_close(self) -> "Frame":
        self.lines.append("«bd|├" + "─" * self.left + "┴" + "─" * self.right + "┤»")
        return self

    # ---- content ------------------------------------------------------
    def full(self, s: str = "") -> "Frame":
        self.lines.append("«bd|│»" + pad(s, self.inner) + "«bd|│»")
        return self

    def cols(self, l: str = "", r: str = "", div: str = "│", dividercls: str = "bd") -> "Frame":
        self.lines.append(
            "«bd|│»" + pad(l, self.left) + f"«{dividercls}|{div}»" + pad(r, self.right) + "«bd|│»"
        )
        return self

    def render(self) -> str:
        return "\n".join(emit(l) for l in self.lines)


def rj(left: str, right: str, w: int) -> str:
    """Left text with `right` flushed to column w."""
    gap = w - vis(left) - vis(right)
    return left + " " * max(1, gap) + right


# =====================================================================
# Shared content pieces
# =====================================================================
INNER = 112
LEFTW = 34  # 30% of 112 = 33.6 -> 34, inside the 28..44 clamp


def sect(label: str, w: int) -> str:
    """A labelled section rule that fills exactly `w` cells."""
    head = f" \u2500\u2500 {label} "
    return "«dim|" + head + "\u2500" * max(0, w - cell_width(head)) + "»"


def rule(w: int) -> str:
    """A plain horizontal rule filling exactly `w` cells."""
    return "«dim|" + "\u2500" * w + "»"


HDR1 = "«acc|◆» «b|implementer»«dim|(impl)» «dim|·» «acc2|anthropic/claude-sonnet-4-6» «dim|·» supervised «dim|·» round «b|3/5» «dim|·» 4m12s"
HDR2 = "«dim|writes» .worktrees/impl «dim|·» «dim|branch» feat/auth-refresh «dim|·» «dim|skills» implement, tdd «dim|·» «dim|clone» task_only «dim|·» «dim|heartbeat» 3m×5"

LIST_ROWS = [
    ("«dim|run a1b2 · supervised · 2 forks»", None),
    ("«sel|«acc|▶» «acc|◆» «b|implementer»«dim|(impl)»  «dim|3/5» «warn|☑3/7»»", None),
    ("«sel|    «muted|writing token-refresh tests»»", None),
    ("  «acc|◆» «b|reviewer»«dim|(rev)»     «dim|2/5»", None),
    ("    «muted|reading the middleware diff»", None),
    ("", None),
    ("«dim|run c7d9 · direct · 1 fork»", None),
    ("  «success|✓» «b|explorer»«dim|(scout)»    «dim|done»", None),
    ("    «muted|found 3 call sites»", None),
    ("", None),
    ("«dim|detached · driver»", None),
    ("  «acc|◆» «b|e2e-gates»       «dim|11m»", None),
    ("    «muted|pid 48211 · phase run»", None),
]

FOOT_LIST = "«dim|↑↓ select · ⏎ open · tab pane · l live · s message · x cancel · q close»"
FOOT_TRANSCRIPT = "«dim|↑↓ scroll · ⏎ expand · esc back · tab pane · t think · g tools · s message · q close»"


def list_col(i: int) -> str:
    return LIST_ROWS[i][0] if i < len(LIST_ROWS) else ""


# =====================================================================
# Section 1 — landing: two panes, summary level
# =====================================================================
def sec_landing() -> str:
    f = Frame(INNER, LEFTW)
    RW = f.right
    f.top("«acc b|delegate» «dim|· 3 runs · 3 live»")
    f.full(" " + HDR1)
    f.full(" " + HDR2)
    f.split_open()
    right = [
        " «acc b|summary»",
        "",
        " lifecycle «acc|running»  health «success|ok»  friction «dim|none»",
        " rounds «b|3/5» · elapsed 4m12s · «dim|↑18.4k ↓4.2k · $0.084»",
        "",
        sect("plan", RW),
        " «warn|☑ 3/7» «dim|·» 3 done «dim|·» 1 active «dim|·» «warn|1 blocked» «dim|·» 2 pending",
        " «acc|▸ active» add the expired-token 401 case",
        " «warn|⚠ blocked» «dim|needs the gateway constant»",
        " «success|✓»«success|✓»«success|✓»«acc|▸»«warn|⚠»«dim|☐»«dim|☐»  «dim|per-task status»",
        " «dim|titles other than the active one do not cross the seam»",
        "",
        sect("latest exchange", RW),

        " «dim|ask» Add tests for the token-refresh path and the 401 case.",
        " «dim|reply» Both tests pass; refresh needed a clock-skew tolerance.",
        "",
        " «dim|⏎ opens the transcript»",
    ]
    for i in range(max(len(LIST_ROWS), len(right))):
        f.cols(" " + list_col(i) if list_col(i) else "", right[i] if i < len(right) else "")
    f.split_close()
    f.full(" " + FOOT_LIST)
    f.bottom()
    return f.render()


# =====================================================================
# Section 2 — transcript level
# =====================================================================
def sec_transcript() -> str:
    f = Frame(INNER, LEFTW)
    RW = f.right
    f.top("«acc b|delegate» «dim|· 3 runs · 3 live»")
    f.full(" " + HDR1)
    f.full(" " + HDR2)
    f.split_open()
    right = [
        " «dim|▸ worker · 14:02:48»  «dim|(sticky heading)»",
        rule(RW),
        " «think|🧠 worker thinking» «dim|▾»",
        " «muted|Planning the diff inspection: check the branch, then read the two»",
        " «muted|call sites before touching the test file.»",
        "",
        rj(" «dim|⚙ bash»    git branch --show-current", "«success|✓ 0.2s» ", RW),
        rj(" «dim|⚙ bash»    git diff --numstat", "«success|✓ 13s» ", RW),
        rj(" «dim|⚙ read»    src/auth/middleware.ts", "«success|✓ 0.1s» ", RW),
        rj(" «dim|⚙ edit»    src/auth/middleware.test.ts «dim|+38 −2»", "«success|✓ 0.3s» ", RW),
        rj(" «err|⚙ bash»    npm test -- auth", "«err|✗ 4.2s» ", RW),
        " «err|│» FAIL src/auth/middleware.test.ts",
        " «err|│»   ● token refresh › tolerates clock skew",
        " «err|│»     Expected: 200   Received: 401",
        "",
        " «success b|▸ worker» «dim|· 14:03:20»",
        " «b|Clock skew tolerance»",
        "  Both tests pass now. The refresh path needed a tolerance; I used",
        "  «acc2|30s» to match the gateway. Two things worth your attention:",
        "",
        "  «dim|•» the gateway value is «acc2|hard-coded» in `config/auth.ts`",
        "  «dim|•» the 401 case still relies on a fake clock",
        " «dim|⋯ +14 lines · ⏎ expands»",
        "",
        rule(RW),
        " «warn|⏳ waiting for worker» «dim|· 6m16s · heartbeat 3/5 · bash npm test»",
    ]
    for i in range(max(len(LIST_ROWS), len(right))):
        f.cols(" " + list_col(i) if list_col(i) else "", right[i] if i < len(right) else "")
    f.split_close()
    f.full(" " + FOOT_TRANSCRIPT)
    f.bottom()
    return f.render()


# =====================================================================
# Section 3 — before / after of the transcript body
# =====================================================================
def sec_before() -> str:
    W = 78
    f = Frame(W)
    f.top("«dim|today»")
    rows = [
        " «warn|S│» «acc|▸ supervisor → worker» «dim|· 21:47:00»",
        " «warn|S│» Perform the requested read-only pre-commit review now.",
        " «warn|S│» Inspect the complete current 12-file dirty diff on branch",
        " «warn|S│» staging/dossier-ui-v2 plus immediate call sites. Do not",
        " «warn|S│» «dim|⋯ +11 lines · f unfolds»",
        " «success|W│» «think|🧠 worker thinking ▾»",
        " «success|W│» «muted|│ **Establishing branch and diff details**»",
        " «success|W│» «dim|⚙ bash  git branch --show-current && git status --sho…»",
        " «success|W│» «dim|⚙ bash  printf 'scope=.spec files≈20 time≈1s hypothes…»",
        " «success|W│» «dim|⚙ bash  git diff --numstat  ✓ 13s»",
        " «success|W│» «think|🧠 worker thinking ▾»",
        " «success|W│» «muted|│ **Planning full diff and status inspection**»",
        " «success|W│» «dim|⚙ bash  git status --short --branch; git diff --name-…»",
        " «warn|S│» «dim|⚙ wait_for_worker  {}  ✓ 6m16s»",
        " «success|W│» «think|🧠 worker thinking ▾»",
        " «warn|S│» «dim|⚙ wait_for_worker  {}  ✓ 3m01s»",
    ]
    for r in rows:
        f.full(r)
    f.bottom()
    return f.render()


def sec_after() -> str:
    W = 78
    f = Frame(W)
    f.top("«acc|redesigned»")
    rows = [
        sect("round 1 \u00b7 21:47:00 \u00b7 12 tools \u00b7 1 error", W),
        " «acc b|▸ supervisor → worker» «dim|· 21:47:00»",
        "  Perform the requested read-only pre-commit review now. Inspect the",
        "  complete current 12-file dirty diff on branch «acc2|staging/dossier-ui-v2»",
        " «dim|⋯ +11 lines · ⏎ expands»",
        "",
        " «think|🧠 worker thinking» «dim|▾»",
        " «muted|Establishing branch and diff details»",
        rj(" «dim|⚙ bash»   git branch --show-current", "«success|✓ 0.2s» ", W),
        rj(" «dim|⚙ bash»   git diff --numstat", "«success|✓ 13s» ", W),
        "",
        " «think|🧠 worker thinking» «dim|▾»",
        " «muted|Planning full diff and status inspection»",
        rj(" «dim|⚙ bash»   git status --short --branch", "«success|✓ 0.4s» ", W),
        rj(" «dim|⚙ bash»   git diff -- frontend/src/hooks/use-workspace-chat.ts", "«success|✓ 1.1s» ", W),
        "",
        rule(W),
        " «warn|⏳ waiting for worker» «dim|· 9m17s · heartbeat 3/5»",
    ]
    for r in rows:
        f.full(r)
    f.bottom()
    return f.render()


# =====================================================================
# Section 4 — header anatomy
# =====================================================================
def sec_header() -> str:
    f = Frame(INNER)
    f.top("«acc b|delegate» «dim|· 3 runs · 3 live»")
    f.full(" " + HDR1)
    f.full(" " + HDR2)
    f.rule()
    f.full(" «dim|line 1 — identity: who is running, on what model, in what shape, how far in»")
    f.full(" «dim|line 2 — policy: what this worker was actually allowed to do»")
    f.full("")
    f.full(" «dim|a read-only worker instead reads:»")
    f.full(" «warn|read-only» «dim|·» «dim|no worktree» «dim|·» «dim|skills» review «dim|·» «dim|clone» snippet «dim|·» «dim|heartbeat» off")
    f.full("")
    f.full(" «dim|gone from the header: run id, run counter, view name, fork strip, ‘N forks’»")
    f.full(" «dim|— the left column already answers every one of them»")
    f.bottom()
    return f.render()


# =====================================================================
# Section 5 — left column anatomy
# =====================================================================
def sec_left() -> str:
    W = 46
    f = Frame(W)
    f.top("«dim|left column · 30% of modal, clamped 28…44»")
    rows = [
        " «dim|run a1b2 · supervised · 2 forks»",
        " «sel|«acc|▶» «acc|◆» «b|implementer»«dim|(impl)»   «dim|3/5» «warn|☑3/7»»",
        " «sel|     «muted|writing token-refresh tests»»",
        "   «acc|◆» «b|reviewer»«dim|(rev)»      «dim|2/5» «dim|☑5/5»",
        "     «muted|reading the middleware diff»",
        "   «warn|⏸» «b|reviewer»«dim|(audit)»    «dim|1/5»",
        "     «warn|awaiting escalation»",
        "",
        " «dim|run c7d9 · direct · 1 fork»",
        "   «success|✓» «b|explorer»«dim|(scout)»     «dim|done»",
        "     «muted|found 3 call sites»",
        "",
        " «dim|detached · driver»",
        "   «acc|◆» «b|e2e-gates»        «dim|11m»",
        "     «muted|pid 48211 · phase run»",
        "   «err|✗» «b|nightly»          «dim|2h»",
        "     «err|exited · reason timeout»",
    ]
    for r in rows:
        f.full(r)
    f.bottom()
    return f.render()


# =====================================================================
# Section 6 — detached: status card, then event log
# =====================================================================
def sec_detached() -> str:
    f = Frame(INNER, LEFTW)
    RW = f.right
    f.top("«acc b|delegate» «dim|· detached run selected»")
    f.full(" «acc|◆» «b|e2e-gates» «dim|·» driver «dim|·» «acc2|detached» «dim|·» pid 48211 «dim|·» 11m04s")
    f.full(" «dim|another process · status is read from durable state, refreshed each second»")
    f.split_open()
    left = [
        "«dim|detached · driver»",
        "«sel|«acc|▶» «acc|◆» «b|e2e-gates»    «dim|11m»»",
        "«sel|    «muted|pid 48211 · phase run»»",
        "  «err|✗» «b|nightly»      «dim|2h»",
        "    «err|exited · timeout»",
    ]
    right = [
        " «acc b|status»",
        "",
        " state «acc|running» · phase «acc2|run» · elapsed 11m04s",
        " last event-bus activity 6s ago · runner pid 48211",
        "",
        sect("event log", RW),
        " «dim|21:36:12» «acc2|run.start»      3 lanes queued",
        " «dim|21:36:14» «acc2|lane.start»     lane=schema",
        " «dim|21:38:40» «acc2|lane.done»      lane=schema ok",
        " «dim|21:38:41» «acc2|lane.start»     lane=api",
        " «dim|21:47:02» «warn|lane.retry»     lane=api attempt=2",
        "",
        " «warn|events, not a conversation» «dim|— no speaker headings are invented»",
        " «dim|for a run this process cannot observe directly»",
    ]
    for i in range(max(len(left), len(right))):
        f.cols(" " + left[i] if i < len(left) else "", right[i] if i < len(right) else "")
    f.split_close()
    f.full(" «dim|↑↓ scroll · esc back · tab pane · q close»")
    f.bottom()
    return f.render()


# =====================================================================
# Section 7 — compose in the detail pane; prompt banner full width
# =====================================================================
def sec_compose() -> str:
    f = Frame(INNER, LEFTW)
    RW = f.right
    f.top("«acc b|delegate» «dim|· composing»")
    f.full(" " + HDR1)
    f.full(" " + HDR2)
    f.split_open()
    right = [
        " «success b|▸ worker» «dim|· 14:03:20»",
        "  Both tests pass. The refresh path needed a clock-skew tolerance;",
        "  I used «acc2|30s» to match the gateway.",
        "",
        rule(RW),
        " «acc|steer → worker» «dim|· delivered at the top of the next round»",
        " «acc|▌»use the gateway constant, don't hard-code 30s",
        " «dim|⏎ send · m mode · esc cancel»",
    ]
    for i in range(max(len(LIST_ROWS), len(right))):
        f.cols(" " + list_col(i) if list_col(i) else "", right[i] if i < len(right) else "")
    f.split_close()
    f.full(" «dim|⏎ send · m cycles push / follow-up / queue · esc back to reading»")
    f.bottom()
    return f.render()


def sec_prompt() -> str:
    f = Frame(INNER, LEFTW)
    f.top("«acc b|delegate» «dim|· worker is waiting on you»")
    f.full(" " + HDR1)
    f.full(" " + HDR2)
    f.rule()
    f.full(" «warn b|impl is asking» «dim|· 14:06:02 · 1 of 2 pending»")
    f.full("")
    f.full("  The gateway constant lives in `config/auth.ts` but is not exported.")
    f.full("  Export it, or duplicate the value in the middleware?")
    f.full("")
    f.full("  «success|y» export it   «err|n» duplicate the value   «dim|s» skip all pending")
    f.rule()
    f.full(" «dim|a blocking prompt takes the full width — it is the reason the overlay opened»")
    f.bottom()
    return f.render()


# =====================================================================
# Section 8 — narrow fallback
# =====================================================================
def sec_narrow() -> str:
    def frame(title, rows, foot, w=52):
        f = Frame(w)
        f.top(title)
        for r in rows:
            f.full(r)
        f.rule()
        f.full(" " + foot)
        f.bottom()
        return f.render()

    a = frame(
        "«dim|1 · list»",
        [
            " «dim|run a1b2 · supervised»",
            " «sel|«acc|▶ ◆» «b|implementer»«dim|(impl)» «dim|3/5» «warn|☑3/7»»",
            " «sel|     «muted|writing token-refresh tests»»",
            "   «acc|◆» «b|reviewer»«dim|(rev)» «dim|2/5»",
            "     «muted|reading the diff»",
            "",
            " «dim|detached»",
            "   «acc|◆» «b|e2e-gates» «dim|11m»",
        ],
        "«dim|↑↓ · ⏎ open · q close»",
    )
    b = frame(
        "«dim|2 · summary»",
        [
            " «acc|◆» «b|implementer»«dim|(impl)»",
            " «acc2|claude-sonnet-4-6» «dim|· supervised»",
            " «dim|writes» .worktrees/impl",
            "",
            " «acc|running» · «success|ok» · 3/5 · 4m12s",
            " «dim|↑18.4k ↓4.2k · $0.084»",
            "",
            " «warn|☑ 3/7» «dim|· «warn|1 blocked»»",
            " «acc|▸» add the 401 case",
            " «success|✓✓✓»«acc|▸»«warn|⚠»«dim|☐☐»",
        ],
        "«dim|⏎ transcript · esc back»",
    )
    c = frame(
        "«dim|3 · transcript»",
        [
            sect("round 3 \u00b7 12 tools \u00b7 1 err", 52),
            " «success b|▸ worker» «dim|14:03:20»",
            " «b|Clock skew tolerance»",
            "  Both tests pass. I used «acc2|30s»",
            "  to match the gateway.",
            " «dim|⋯ +14 lines · ⏎ expands»",
            "",
            " «warn|⏳ waiting» «dim|6m16s · hb 3/5»",
        ],
        "«dim|↑↓ · ⏎ expand · esc back»",
    )
    return a, b, c


# =====================================================================
# Section 9 — completed banner
# =====================================================================
def sec_completed() -> str:
    f = Frame(INNER, LEFTW)
    f.top("«acc b|delegate» «dim|· all work settled»")
    f.full(" «success|✓» «b|implementer»«dim|(impl)» «dim|·» «acc2|anthropic/claude-sonnet-4-6» «dim|·» supervised «dim|·» «b|5/5» «dim|·» 9m41s")
    f.full(" «dim|writes» .worktrees/impl «dim|·» «dim|branch» feat/auth-refresh «dim|·» «dim|skills» implement, tdd")
    f.rule()
    f.full(" «success b|completed» «dim|·» «success|succeeded 2» «dim|·» «dim|failed 0» «dim|·» «dim|aborted 0» «dim|·» «dim|↑41.2k ↓9.8k · $0.211 · q closes»")
    f.rule()
    f.full(" «dim|the modal does not dismiss itself — the result stays on screen until you close it»")
    f.bottom()
    return f.render()


# =====================================================================
# Assemble
# =====================================================================
narrow_a, narrow_b, narrow_c = sec_narrow()

KEYS_KEPT = [
    ("⏎", "Open the selection. In the transcript, expand the selected message, thinking trace, or tool chip."),
    ("Esc", "Back one level: transcript → summary → list → close."),
    ("q", "Close from anywhere."),
    ("↑ ↓", "Move the selection in the list; scroll in the transcript (pauses auto-follow)."),
    ("← →", "Move focus between the two panes."),
    ("Tab / ⇧Tab", "Move focus between the two panes."),
    ("PgUp / PgDn", "Page the focused pane."),
    ("Home / End", "First / last. <code>End</code> resumes auto-follow in the transcript."),
    ("l", "Jump to the next live fork, wherever it is."),
    ("t", "Cycle thinking traces: preview / full / hidden."),
    ("g", "Cycle tool nodes: chip / expanded / hidden."),
    ("s", "Compose a message to the selected supervised fork; skip all pending prompts when a prompt is up."),
    ("m", "Cycle delivery mode before typing: push / follow-up / queue."),
    ("x", "Cancel the selected live fork (confirms)."),
    ("y / n", "Answer the active confirmation or worker prompt."),
    ("r", "Manual refresh."),
]

KEYS_GONE = [
    ("1–9", "Direct fork select", "The list selects with ↑↓ and never scrolls out of view."),
    ("{ }", "Previous / next run", "Runs are group headings in one list, not a level you page through."),
    ("[ ]", "Previous / next message", "↑↓ scrolls and ⏎ expands; jumping by message was rarely used."),
    ("← →", "Previous / next fork", "Repurposed: the explorer gesture is moving between panes."),
    ("f", "Fold / unfold messages", "Folding is always on; ⏎ expands the one message you want."),
]

CSS = """
  :root{
    --bg:#0d1117; --panel:#0b0e14; --chrome:#161b22; --border:#30363d;
    --text:#c9d1d9; --muted:#8b949e; --dim:#6e7681;
    --accent:#58a6ff; --accent2:#79c0ff;
    --success:#3fb950; --warning:#d29922; --error:#f85149;
    --think:#bc8cff; --sel:#1c2333;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:#010409; color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    line-height:1.55; padding:32px 20px 90px;
  }
  .wrap{max-width:1120px; margin:0 auto}
  h1{font-size:25px; margin:0 0 4px}
  .sub{color:var(--muted); margin:0 0 10px; font-size:14px}
  h2{font-size:15px; letter-spacing:.04em; text-transform:uppercase; color:var(--accent2);
     margin:44px 0 6px; border-bottom:1px solid var(--border); padding-bottom:6px}
  h3{font-size:13.5px; color:var(--text); margin:22px 0 4px; font-weight:600}
  .note{color:var(--muted); font-size:13.5px; margin:6px 0 14px; max-width:78ch}
  .note b{color:var(--text)}
  .note code, td code, li code{background:var(--chrome); border-radius:3px; padding:0 4px;
       font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace; font-size:12px; color:var(--accent2)}
  kbd{background:var(--chrome); border:1px solid var(--border); border-bottom-width:2px;
      border-radius:4px; padding:1px 6px; font-size:11.5px; color:var(--text); font-family:inherit;
      white-space:nowrap}
  .term{background:var(--bg); border:1px solid var(--border); border-radius:8px;
        overflow:hidden; box-shadow:0 8px 30px rgba(0,0,0,.5); margin:14px 0}
  .titlebar{background:var(--chrome); padding:8px 12px; display:flex; align-items:center; gap:8px;
            border-bottom:1px solid var(--border)}
  .dot{width:12px; height:12px; border-radius:50%}
  .r{background:#ff5f56}.y{background:#ffbd2e}.g{background:#27c93f}
  .titlebar .t{color:var(--dim); font-size:12px; margin-left:6px}
  pre{margin:0; padding:14px 16px; font-size:12.5px; line-height:1.5;
      font-family:"SF Mono",ui-monospace,"Cascadia Code",Menlo,Consolas,monospace;
      white-space:pre; overflow-x:auto; tab-size:2}
  .acc{color:var(--accent)} .acc2{color:var(--accent2)}
  .success{color:var(--success)} .warn{color:var(--warning)} .err{color:var(--error)}
  .muted{color:var(--muted)} .dim{color:var(--dim)} .think{color:var(--think)}
  .bd{color:var(--border)}
  .b{font-weight:700; color:var(--text)}
  .sel{background:var(--sel)}
  .cap{font-size:12px; color:var(--dim); margin:2px 2px 0; max-width:88ch}
  .cols3{display:grid; grid-template-columns:repeat(3,1fr); gap:12px}
  @media(max-width:900px){.cols3{grid-template-columns:1fr}}
  table{border-collapse:collapse; width:100%; margin:10px 0 4px; font-size:13px}
  th,td{text-align:left; padding:5px 10px; border-bottom:1px solid var(--border); vertical-align:top}
  th{color:var(--accent2); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em}
  td:first-child{white-space:nowrap; width:1%}
  .decision{border-left:3px solid var(--accent); background:rgba(88,166,255,.05);
            padding:10px 14px; margin:14px 0; font-size:13.5px; color:var(--muted); max-width:88ch}
  .decision b{color:var(--text)}
  ul{margin:8px 0 14px; padding-left:22px; color:var(--muted); font-size:13.5px; max-width:80ch}
  li{margin:3px 0}
"""


def term(title, body, cap=None):
    out = [
        '  <div class="term">',
        f'    <div class="titlebar"><span class="dot r"></span><span class="dot y"></span>'
        f'<span class="dot g"></span><span class="t">{html.escape(title)}</span></div>',
        f"<pre>{body}</pre>",
        "  </div>",
    ]
    if cap:
        out.append(f'  <p class="cap">{cap}</p>')
    return "\n".join(out)


doc = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pi-delegate — overlay explorer redesign</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>pi-delegate — overlay explorer redesign</h1>
  <p class="sub">Illustrative only. These convey the <i>information architecture</i>, not pixel-final styling.
  Every frame below is column-accurate at the width it claims.</p>

  <div class="decision">
    <b>What changes.</b> The right-docked panel with three stacked views becomes a <b>centered modal
    with two panes</b>: a persistent fork list on the left, that fork's detail on the right. The
    navigation header is replaced by the worker's identity and policy. The separate rounds view is
    deleted. The per-line speaker rail is deleted. Prose renders as real markdown. Repeated
    <code>wait_for_worker</code> calls collapse into one pinned live row.
  </div>

  <div class="legend note">
    <kbd>◆</kbd> running &nbsp; <kbd>✓</kbd> done &nbsp; <kbd>⏸</kbd> paused/awaiting &nbsp;
    <kbd>✗</kbd> failed &nbsp; <kbd>☑</kbd> task checklist &nbsp; <kbd>⏳</kbd> waiting
  </div>

  <!-- ========================================================= -->
  <h2>1 · Landing — two panes, summary level</h2>
  <p class="note">Opening the overlay lands here. The left column lists every fork in the session,
  grouped by run, with a <b>detached</b> group for driver runs in another process. The right
  pane summarises the selected fork. Nothing is a mode you have to leave to see something else.</p>
{term("pi · delegate overlay · 128 cols", sec_landing())}
  <p class="cap">Left column is 30% of the modal, clamped to 28…44 columns. Each fork gets two lines:
  identity with a task chip, then its live activity headline — the same two-line shape the below-editor
  widget already uses.</p>
  <div class="decision">
    <b>Checklist parity, and its hard limit.</b> The <code>☑3/7</code> chip is exactly what the
    below-editor widget already renders (<code>formatTaskProgressCount</code>), warning-coloured when
    anything is blocked. The <b>plan</b> block in the detail pane is its expansion — but it can only
    show what actually crosses the seam. <code>TaskProgressRow</code> in <code>src/task-seam.ts</code>
    carries <code>status</code>, <code>reason</code>, and an id; the comment on
    <code>TaskProgressFields.rows</code> is explicit that <i>titles stay remote</i>. Only
    <code>progress.active</code> — one string — brings a title across. So the plan block shows the
    counts, the active title, the blocked reason, and a per-task status strip. Rendering the full
    titled checklist would need a change to the <code>context-aware.tasks.v1</code> contract, which is
    a separate piece of work from this redesign.
  </div>

  <!-- ========================================================= -->
  <h2>2 · Transcript level — <kbd>⏎</kbd> from the summary</h2>
  <p class="note">The left column never goes away, so you keep your place. The transcript is where most
  of the redesign lands: <b>markdown prose</b>, <b>block headings instead of a per-line rail</b>,
  <b>round separators</b> carrying the counts the deleted rounds view used to show, <b>one-line tool
  chips</b> with the duration flushed right, and <b>errors that expand themselves</b>.</p>
{term("pi · delegate overlay · transcript", sec_transcript())}
  <p class="cap">Top line of the detail pane is the <b>sticky heading</b>: scrolled deep inside a long
  worker block, it tells you who is talking — the one thing the <code>W│</code> rail was buying.
  The bottom line is the collapsed <code>wait_for_worker</code> state, pinned so it is answerable at a
  glance: is this thing alive right now?</p>

  <!-- ========================================================= -->
  <h2>3 · The transcript body, before and after</h2>
  <p class="note">Same worker, same work. Left is what it looks like today; right is the redesign.
  Four separate changes are doing the work: the rail is gone, <code>**bold**</code> renders as bold,
  repeated <code>wait_for_worker</code> rows collapse into the pinned line, and thinking traces get a
  blank line above them so tool runs stop merging into prose.</p>
  <div class="cols3" style="grid-template-columns:1fr 1fr">
    <div>
{term("today", sec_before())}
    </div>
    <div>
{term("redesigned", sec_after())}
    </div>
  </div>

  <!-- ========================================================= -->
  <h2>4 · The header, reused</h2>
  <p class="note">The old header spent four rows on navigation: run id, run counter, shape, live state,
  fork count, current view name, and a numbered fork strip. The left column now answers all of that.
  The space goes to the two questions the overlay could never answer: <b>what is this worker</b>, and
  <b>what was it allowed to do</b>.</p>
{term("pi · header anatomy", sec_header())}

  <!-- ========================================================= -->
  <h2>5 · The left column</h2>
  <p class="note">One inventory of every piece of delegate work in the session. Runs are group headings,
  not a level you navigate. Forks carry a status glyph, agent(task label), rounds, and the task chip.
  The second line is the live activity headline — a model-written sentence, already produced by the
  activity ticker for the footer widget.</p>
{term("pi · left column · 46 cols", sec_left())}
  <p class="cap">A blocked task turns the chip warning-coloured, matching the widget. Lifecycle truth
  outranks headlines: an <code>awaiting-escalation</code> fork says so instead of showing stale prose.</p>

  <!-- ========================================================= -->
  <h2>6 · Detached driver runs</h2>
  <p class="note">A detached driver runs in another process. There is no
  foreground supervisor↔worker conversation to show, and the overlay must not invent one. It gets rows
  in the left column like everything else; the detail pane shows its status card, and <kbd>⏎</kbd>
  descends into its <b>event log</b> — explicitly labelled as events, with no speaker headings.</p>
{term("pi · detached run selected", sec_detached())}

  <!-- ========================================================= -->
  <h2>7 · Steering and prompts</h2>
  <p class="note">These two used to share one region at the bottom. They are different things and now
  sit differently. <b>Steering</b> is about the selected fork, so it lives in that fork's detail pane.
  A <b>worker prompt</b> is a worker blocked on your answer, so it takes the full width — it is the
  reason the overlay opened at all.</p>
  <h3>Compose — inside the detail pane</h3>
{term("pi · composing a steer", sec_compose())}
  <h3>Worker prompt — full width</h3>
{term("pi · worker is asking", sec_prompt())}

  <!-- ========================================================= -->
  <h2>8 · Narrow terminals and dock mode</h2>
  <p class="note">Below roughly 90 columns the detail pane would fall under the width where prose reads
  well, so the two panes collapse into a <b>single-column drill-down</b>: list → summary → transcript,
  <kbd>Esc</kbd> back out. <code>inspectorLayout: "dock"</code> renders this same path, so the narrow
  code path is exercised on every desktop that keeps the dock.</p>
  <div class="cols3">
    <div>
{term("52 cols · list", narrow_a)}
    </div>
    <div>
{term("52 cols · summary", narrow_b)}
    </div>
    <div>
{term("52 cols · transcript", narrow_c)}
    </div>
  </div>

  <!-- ========================================================= -->
  <h2>9 · Completion</h2>
  <p class="note">Auto-close was designed for a side dock quietly getting out of the way. A centered
  modal dismissing itself takes a just-arrived result off the screen at the exact moment you would read
  it. <code>autoCloseInspectorOnComplete</code> now defaults off; a banner carries the signal instead.
  The banner reuses the widget's own <code>succeeded / failed / aborted</code> rollup
  (<code>renderOutcomeSummary</code>) rather than inventing a second vocabulary for the same fact.</p>
{term("pi · everything settled", sec_completed())}

  <!-- ========================================================= -->
  <h2>10 · Keyboard scheme</h2>
  <p class="note">One global chord opens the overlay (<kbd>Alt+O</kbd>, <kbd>Ctrl+Alt+D</kbd>, or
  <code>/delegate-overlay</code>); everything below is intercepted locally once the modal has focus, so
  it cannot clash with tmux, the editor, or another extension.</p>

  <h3>Kept</h3>
  <table>
    <tr><th>Key</th><th>Action</th></tr>
{chr(10).join(f"    <tr><td><kbd>{html.escape(k)}</kbd></td><td>{a}</td></tr>" for k, a in KEYS_KEPT)}
  </table>

  <h3>Removed</h3>
  <table>
    <tr><th>Key</th><th>Was</th><th>Why it goes</th></tr>
{chr(10).join(f"    <tr><td><kbd>{html.escape(k)}</kbd></td><td>{html.escape(w)}</td><td>{html.escape(y)}</td></tr>" for k, w, y in KEYS_GONE)}
  </table>

  <!-- ========================================================= -->
  <h2>11 · Why <code>wait_for_worker</code> exists at all</h2>
  <p class="note">Worth writing down, because the rows it produced are most of what made the transcript
  look broken.</p>
  <ul>
    <li>The supervisor is a real agent session with its own tool loop, not a passive pipe.</li>
    <li><code>message_subagent</code> deliberately does not block forever. After
        <code>heartbeatIntervalMs</code> of worker silence (default 3 minutes) it returns a
        <b>heartbeat</b> payload instead of a reply.</li>
    <li>That hands control back to the supervisor model, which can keep waiting,
        <code>inspect_worker</code>, <code>restart_worker</code>, <code>cancel_worker</code>, or
        <code>finish_delegation</code>.</li>
    <li>"Keep waiting" is <code>wait_for_worker</code>. It re-awaits the <i>same</i> in-flight promise —
        it does not re-prompt the worker and does not consume a round.</li>
    <li>So one row appears per heartbeat interval for the life of a slow fork. It costs one supervisor
        model round-trip each time.</li>
  </ul>
  <div class="decision">
    <b>Decision.</b> Only <code>wait_for_worker</code> collapses. <code>inspect_worker</code> stays
    visible because its presence means the supervisor thought something was wrong;
    <code>message_subagent</code>, <code>cancel_worker</code>, <code>restart_worker</code>, and
    <code>finish_delegation</code> stay because they are decisions you would be surprised to find
    missing from a transcript. Whether the runtime should re-await automatically — removing the model
    round-trip, not just the pixels — is a separate question about the heartbeat contract, not a
    rendering change.
  </div>

  <!-- ========================================================= -->
  <h2>12 · Staging</h2>
  <ul>
    <li><b>Stage 1 — layout and header.</b> Centered modal, two panes, left-column inventory with the
        detached group, header identity/policy lines, summary level, narrow single-column fallback,
        <code>inspectorLayout</code> defaulting to centered.</li>
    <li><b>Stage 2 — transcript rendering.</b> Markdown prose, block headings with a sticky heading,
        round separators, pi-styled tool chips with auto-expanding errors, the collapsed
        <code>wait_for_worker</code> pinned row, <kbd>⏎</kbd> to expand a folded message.</li>
    <li><b>Stage 3 — keys, tasks, completion.</b> The new key scheme, the task chip and checklist,
        the completion banner, and the README plus
        <code>tests/unit/readme-overlay-contract.test.ts</code> rewritten to match.</li>
  </ul>
</div>
</body>
</html>
"""

path = sys.argv[1] if len(sys.argv) > 1 else "docs/mockups/delegate-tui-mockups.html"
with open(path, "w", encoding="utf-8") as fh:
    fh.write(doc)
print(f"wrote {path}")
