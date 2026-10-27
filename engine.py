"""Pure, deterministic Graphshot combat engine. No HTTP or database imports."""
from __future__ import annotations
import math
import re
from dataclasses import dataclass

SPEED, HIT_RADIUS, DURATION, STEP = 18.0, 0.85, 3.2, 0.12
FUNCS = {
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "sqrt": math.sqrt,
    "abs": abs,
    "ln": math.log,
    "log": math.log10,
    "exp": math.exp,
}
CONSTS = {"pi": math.pi, "e": math.e}


def compile_equation(source: str):
    """Bounded expression parser; deliberately never calls eval/exec.
    
    Supports basic arithmetic (+, -, *, /, ^), constants (pi, e),
    functions (sin, cos, tan, sqrt, abs, ln, log, exp), variable (x),
    and implicit multiplication (e.g. 2x, 3sin(x), 2(x+1)).
    """
    if not isinstance(source, str) or not 0 < len(source.strip()) <= 180:
        raise ValueError("Equation must be 1–180 characters")

    raw = source.lower().replace("π", "pi").replace("**", "^").replace(" ", "")
    raw_tokens = re.findall(r"sin|cos|tan|sqrt|abs|ln|log|exp|pi|\be\b|x|\d*\.?\d+|[()+\-*/^]", raw)
    if not raw_tokens or "".join(raw_tokens) != raw:
        raise ValueError("Unsupported equation syntax")

    # Insert implicit multiplication tokens where appropriate:
    # e.g., (number|constant|x|')') followed by (function|constant|x|'(')
    toks: list[str] = []
    def is_value_end(t: str) -> bool:
        if t in ("x", "pi", "e", ")"):
            return True
        try:
            float(t)
            return True
        except ValueError:
            return False

    def is_value_start(t: str) -> bool:
        return t in ("x", "pi", "e", "(") or t in FUNCS or bool(re.match(r"^\d*\.?\d+$", t))

    for idx, t in enumerate(raw_tokens):
        toks.append(t)
        if idx + 1 < len(raw_tokens):
            nxt = raw_tokens[idx + 1]
            if is_value_end(t) and is_value_start(nxt):
                toks.append("*")

    i = 0

    def expr():
        nonlocal i
        left = term()
        while i < len(toks) and toks[i] in "+-":
            op = toks[i]
            i += 1
            right = term()
            old = left
            left = (lambda x, old=old, right=right, op=op: old(x) + right(x) if op == "+" else old(x) - right(x))
        return left

    def term():
        nonlocal i
        left = power()
        while i < len(toks) and toks[i] in "*/":
            op = toks[i]
            i += 1
            right = power()
            old = left
            def safe_mul_div(x, old=old, right=right, op=op):
                r = right(x)
                if op == "*":
                    return old(x) * r
                if r == 0:
                    raise ZeroDivisionError("Division by zero")
                return old(x) / r
            left = safe_mul_div
        return left

    def power():
        nonlocal i
        left = atom()
        if i < len(toks) and toks[i] == "^":
            i += 1
            right = power()
            old = left
            def safe_pow(x, old=old, right=right):
                base = old(x)
                exponent = right(x)
                if base < 0 and not float(exponent).is_integer():
                    raise ValueError("Negative base with non-integer exponent produces complex number")
                val = base ** exponent
                if isinstance(val, complex):
                    raise ValueError("Calculation produced complex number")
                return val
            left = safe_pow
        return left

    def atom():
        nonlocal i
        if i >= len(toks):
            raise ValueError("Expression ends too early")
        t = toks[i]
        i += 1
        if t == "+":
            return atom()
        if t == "-":
            f = atom()
            return lambda x: -f(x)
        if t == "(":
            f = expr()
            if i >= len(toks) or toks[i] != ")":
                raise ValueError("Missing closing parenthesis")
            i += 1
            return f
        if t == "x":
            return lambda x: float(x)
        if t in CONSTS:
            c = CONSTS[t]
            return lambda x: c
        if t in FUNCS:
            if i >= len(toks) or toks[i] != "(":
                raise ValueError(f"{t} needs parentheses")
            i += 1
            a = expr()
            if i >= len(toks) or toks[i] != ")":
                raise ValueError("Missing closing parenthesis")
            i += 1
            fn = FUNCS[t]
            def safe_fn(x, fn=fn, a=a, name=t):
                arg = a(x)
                if name in ("ln", "log") and arg <= 0:
                    raise ValueError("Logarithm of non-positive number")
                if name == "sqrt" and arg < 0:
                    raise ValueError("Square root of negative number")
                return fn(arg)
            return safe_fn
        try:
            n = float(t)
            return lambda x: n
        except ValueError:
            raise ValueError(f"Unexpected token: {t}")

    fn = expr()
    if i != len(toks):
        raise ValueError("Could not parse the full equation")

    def safe(x: float) -> float:
        try:
            y = fn(x)
        except (ArithmeticError, ValueError, TypeError) as e:
            raise ValueError(f"Evaluation error: {e}")
        if isinstance(y, complex):
            raise ValueError("Calculation produced complex number")
        if not math.isfinite(y) or abs(y) > 1000:
            raise ValueError("Equation left the safe range")
        return float(y)

    return safe


@dataclass
class Player:
    id: str
    name: str
    rating: int = 1000
    bot: bool = False
    x: float = 0.0
    y: float = 0.0
    angle: float = 0.0
    alive: bool = True
    kills: int = 0
    hits: int = 0
    score: int = 25


def arena(players: list[Player]) -> list[Player]:
    n = max(1, len(players))
    for i, p in enumerate(players):
        a = i / n * 2 * math.pi - math.pi / 2
        p.x = 18.0 * math.cos(a)
        p.y = 18.0 * math.sin(a)
        p.angle = a + math.pi
    return players


def bot_equation(rating: int) -> str:
    return "-0.018*x^2+0.62*x" if rating > 1600 else "0.35*x" if rating > 1200 else "0"


def _path(p: Player, equation: str) -> list[tuple[float, float, float]]:
    try:
        f = compile_equation(equation)
        base = f(0.0)
    except Exception:
        f = compile_equation("0")
        base = 0.0

    out: list[tuple[float, float, float]] = []
    c, s = math.cos(p.angle), math.sin(p.angle)
    max_steps = int(SPEED * DURATION / STEP) + 1

    for n in range(max_steps):
        local_x = n * STEP
        try:
            local_y = f(local_x) - base
        except Exception:
            # Trajectory safely terminates if calculation becomes undefined (e.g. asymptote)
            break
        if abs(local_y) > 40:
            break
        out.append((p.x + local_x * c - local_y * s, p.y + local_x * s + local_y * c, local_x / SPEED))

    if not out:
        out.append((p.x, p.y, 0.0))
    return out


def _distance(px: float, py: float, a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    ax, ay, _ = a
    bx, by, _ = b
    dx, dy = bx - ax, by - ay
    q = dx * dx + dy * dy or 1.0
    u = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / q))
    return math.hypot(px - (ax + u * dx), py - (ay + u * dy))


def resolve_volley(players: list[Player], submissions: dict[str, str]) -> dict:
    """All cannons begin together; death invalidates its owner's later beam events."""
    beams: dict[str, list[tuple[float, float, float]]] = {}
    events: list[tuple[float, str, str]] = []

    for shooter in players:
        default_eq = bot_equation(shooter.rating) if shooter.bot else "0"
        raw_eq = submissions.get(shooter.id, default_eq)
        try:
            path = _path(shooter, raw_eq)
        except Exception:
            path = _path(shooter, "0")
        beams[shooter.id] = path

        for n in range(1, len(path)):
            for target in players:
                if target.id != shooter.id and _distance(target.x, target.y, path[n - 1], path[n]) <= HIT_RADIUS:
                    events.append((path[n][2], shooter.id, target.id))

    events.sort()
    by = {p.id: p for p in players}
    alive = set(by.keys())
    deaths = []

    for t, shooter, target in events:
        if shooter not in alive or target not in alive:
            continue
        alive.remove(target)
        by[target].alive = False
        by[shooter].kills += 1
        by[shooter].hits += 1
        deaths.append({"time": round(t, 4), "shooter": shooter, "target": target})

    for p in players:
        p.score += 100 if p.alive else 0
        p.score += p.kills * 180 + p.hits * 40

    return {
        "deaths": deaths,
        "players": [
            {
                "id": p.id,
                "name": p.name,
                "bot": p.bot,
                "alive": p.alive,
                "kills": p.kills,
                "score": p.score,
                "x": round(p.x, 3),
                "y": round(p.y, 3),
            }
            for p in players
        ],
        "beams": {
            k: [[round(x, 2), round(y, 2)] for x, y, _ in v[::4]]
            for k, v in beams.items()
        },
    }
