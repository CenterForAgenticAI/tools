# Shared Bend proof library for compiled-intent models.
# Copy beside a model and import it: `import ./Lib.bend as L`.
# Checked with Bend 2.0.35 (--check-only; --verdict still fails, see SPEC). Every law here is proven; no @unsafe, no ?TODO.
import Base

# T(b): the proposition "b is True".
def T(b: Bool) -> Data:
  match b:
    case False{}:
      Empty
    case True{}:
      Unit

def andL(a: Bool, -b: Bool, h: T(Bool.and(a, b))) -> T(a):
  match a:
    case False{}:
      h
    case True{}:
      Unit{}

def andR(a: Bool, -b: Bool, h: T(Bool.and(a, b))) -> T(b):
  match a:
    case False{}:
      Empty.absurd(T(b), h)
    case True{}:
      h

def NotIn(-A: Data, +x: A, xs: List<&2, A>) -> Type:
  match xs:
    case Nil{}:
      Unit
    case h <> t:
      {x != h : A} & NotIn(A, x, t)

def Nodup(-A: Data, xs: List<&2, A>) -> Type:
  match xs:
    case Nil{}:
      Unit
    case +h <> +t:
      NotIn(A, h, t) & Nodup(A, t)

law nat_eq_refl:
  for n: Nat
  {Nat.is_eq(n, n) == True{} : Bool}

def nat_eq_refl(n):
  match n:
    case 0n:
      {==}
    case 1n+p:
      nat_eq_refl(p)

def discriminate(b: Bool) -> Type:
  match b:
    case False{}:
      Unit
    case True{}:
      Empty

def falseTrue(e: {False{} == True{} : Bool}) -> Empty:
  %e : discriminate(_)
  Unit{}

def neBool(b: Bool, e: {b == True{} : Bool}, h: T(Bool.not(b))) -> Empty:
  match b:
    case False{}:
      falseTrue(e)
    case True{}:
      h

# Generic distinctness by a numeric code. Soundness needs no injectivity of
# code: different codes always mean different values.
def notInC(~A: Data, ~code: A -> Nat, +k: A, xs: List<&2, A>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case h <> t:
      Bool.and(Bool.not(Nat.is_eq(code(k), code(h))), notInC(~A, ~code, k, t))

def distinctC(~A: Data, ~code: A -> Nat, xs: List<&2, A>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case +h <> +t:
      Bool.and(notInC(~A, ~code, h, t), distinctC(~A, ~code, t))

law neq_of_code:
  for ~A: Data
  for ~code: A -> Nat
  for +a: A
  for +b: A
  for h: T(Bool.not(Nat.is_eq(code(a), code(b))))
  {a != b : A}

def neq_of_code(A, code, a, b, h):
  e => neBool(Nat.is_eq(code(a), code(b)), (%e : {Nat.is_eq(code(a), code(_)) == True{} : Bool}; nat_eq_refl(code(a))), h)

law notInC_sound:
  for ~A: Data
  for ~code: A -> Nat
  for +k: A
  for xs: List<&2, A>
  for +h: T(notInC(~A, ~code, k, xs))
  NotIn(A, k, xs)

def notInC_sound(A, code, k, xs, h):
  match xs:
    case Nil{}:
      Unit{}
    case +x <> +t:
      (neq_of_code(~A, ~code, k, x, andL(Bool.not(Nat.is_eq(code(k), code(x))), notInC(~A, ~code, k, t), h)), notInC_sound(~A, ~code, k, t, andR(Bool.not(Nat.is_eq(code(k), code(x))), notInC(~A, ~code, k, t), h)))

law distinctC_sound:
  for ~A: Data
  for ~code: A -> Nat
  for xs: List<&2, A>
  for +h: T(distinctC(~A, ~code, xs))
  Nodup(A, xs)

def distinctC_sound(A, code, xs, h):
  match xs:
    case Nil{}:
      Unit{}
    case +x <> +t:
      (notInC_sound(~A, ~code, x, t, andL(notInC(~A, ~code, x, t), distinctC(~A, ~code, t), h)), distinctC_sound(~A, ~code, t, andR(notInC(~A, ~code, x, t), distinctC(~A, ~code, t), h)))

# ---- Finite products, membership and composite keys ----

# A reusable pair; nest it for more fields: Prd<A, Prd<B, C>>.
type Prd<-A: Data, -B: Data> is Data:
  P{fst: A, snd: B}

def Mem(-A: Data, +x: A, xs: List<&2, A>) -> Type:
  match xs:
    case Nil{}:
      Empty
    case h <> t:
      {x == h : A} | Mem(A, x, t)

def pairWith(-A: Data, -B: Data, +a: A, ys: List<&2, B>) -> List<&2, Prd<A, B>>:
  match ys:
    case Nil{}:
      Nil{}
    case h <> t:
      P{a, h} <> pairWith(A, B, a, t)

# product(xs, ys) lists P{x, y} with x outermost, like Lean's nested appendMap.
def product(-A: Data, -B: Data, xs: List<&2, A>, +ys: List<&2, B>) -> List<&2, Prd<A, B>>:
  match xs:
    case Nil{}:
      Nil{}
    case h <> t:
      List.append(&2, Prd<A, B>, pairWith(A, B, h, ys), product(A, B, t, ys))

def mapL(~A: Data, ~B: Data, ~f: A -> B, xs: List<&2, A>) -> List<&2, B>:
  match xs:
    case Nil{}:
      Nil{}
    case h <> t:
      f(h) <> mapL(~A, ~B, ~f, t)

law mem_append_l:
  for -A: Data
  for +x: A
  for xs: List<&2, A>
  for +ys: List<&2, A>
  for m: Mem(A, x, xs)
  Mem(A, x, List.append(&2, A, xs, ys))

def mem_append_l(A, x, xs, ys, m):
  match xs:
    case Nil{}:
      Empty.absurd(Mem(A, x, ys), m)
    case h <> t:
      match m:
        case Inl{e}:
          Inl{e}
        case Inr{r}:
          Inr{mem_append_l(A, x, t, ys, r)}

law mem_append_r:
  for -A: Data
  for +x: A
  for xs: List<&2, A>
  for +ys: List<&2, A>
  for m: Mem(A, x, ys)
  Mem(A, x, List.append(&2, A, xs, ys))

def mem_append_r(A, x, xs, ys, m):
  match xs:
    case Nil{}:
      m
    case h <> t:
      Inr{mem_append_r(A, x, t, ys, m)}

law mem_pairWith:
  for -A: Data
  for -B: Data
  for +a: A
  for ys: List<&2, B>
  for +b: B
  for m: Mem(B, b, ys)
  Mem(Prd<A, B>, P{a, b}, pairWith(A, B, a, ys))

def mem_pairWith(A, B, a, ys, b, m):
  match ys:
    case Nil{}:
      Empty.absurd(Mem(Prd<A, B>, P{a, b}, Nil{}), m)
    case +h <> t:
      match m:
        case Inl{e}:
          Inl{Equal.cong(B, Prd<A, B>, y => P{a, y}, b, h, e)}
        case Inr{r}:
          Inr{mem_pairWith(A, B, a, t, b, r)}

law mem_product:
  for -A: Data
  for -B: Data
  for xs: List<&2, A>
  for +ys: List<&2, B>
  for +a: A
  for +b: B
  for ma: Mem(A, a, xs)
  for mb: Mem(B, b, ys)
  Mem(Prd<A, B>, P{a, b}, product(A, B, xs, ys))

def mem_product(A, B, xs, ys, a, b, ma, mb):
  match xs:
    case Nil{}:
      Empty.absurd(Mem(Prd<A, B>, P{a, b}, Nil{}), ma)
    case +h <> +t:
      match ma:
        case Inl{e}:
          %e : Mem(Prd<A, B>, P{a, b}, List.append(&2, Prd<A, B>, pairWith(A, B, _, ys), product(A, B, t, ys)))
          mem_append_l(Prd<A, B>, P{a, b}, pairWith(A, B, a, ys), product(A, B, t, ys), mem_pairWith(A, B, a, ys, b, mb))
        case Inr{r}:
          mem_append_r(Prd<A, B>, P{a, b}, pairWith(A, B, h, ys), product(A, B, t, ys), mem_product(A, B, t, ys, a, b, r, mb))

law notIn_map:
  for ~A: Data
  for ~B: Data
  for ~f: A -> B
  for ~inj: @a: A -> @b: A -> @e: {f(a) == f(b) : B} -> {a == b : A}
  for +x: A
  for xs: List<&2, A>
  for h: NotIn(A, x, xs)
  NotIn(B, f(x), mapL(~A, ~B, ~f, xs))

def notIn_map(A, B, f, inj, x, xs, h):
  match xs:
    case Nil{}:
      Unit{}
    case +y <> +t:
      (ne, rest) = h
      (e => ne(inj(x, y, e)), notIn_map(~A, ~B, ~f, ~inj, x, t, rest))

law nodup_map:
  for ~A: Data
  for ~B: Data
  for ~f: A -> B
  for ~inj: @a: A -> @b: A -> @e: {f(a) == f(b) : B} -> {a == b : A}
  for xs: List<&2, A>
  for h: Nodup(A, xs)
  Nodup(B, mapL(~A, ~B, ~f, xs))

def nodup_map(A, B, f, inj, xs, h):
  match xs:
    case Nil{}:
      Unit{}
    case +y <> +t:
      (ni, nd) = h
      (notIn_map(~A, ~B, ~f, ~inj, y, t, ni), nodup_map(~A, ~B, ~f, ~inj, t, nd))

# Mixed-radix code for a pair; nb must exceed every code of B.
def pcode(~A: Data, ~B: Data, ~ca: A -> Nat, ~cb: B -> Nat, +nb: Nat, p: Prd<A, B>) -> Nat:
  match p:
    case P{a, b}:
      Nat.add(Nat.mul(ca(a), nb), cb(b))

def cons1(h: Char, r: String & String) -> String & String:
  (a, b) = r
  (SCon{h, a}, b)

# Split at the first ':'; without one, the whole string and an empty rest.
def split1(s: String) -> String & String:
  match s:
    case SNil{}:
      ("", "")
    case SCon{+h, +t}:
      Bool.pick(String & String, Char.is_eq(h, ':'), ("", t), cons1(h, split1(t)))

def takeFin(~A: Data, ~parse: @+s: String -> A, hr: String & String) -> A & String:
  (h, r) = hr
  (parse(h), r)

# Parse the field before the first ':' and hand back the rest.
def take(~A: Data, ~parse: @+s: String -> A, s: String) -> A & String:
  takeFin(~A, ~parse, split1(s))

def fstOf(-A: Data, p: A & String) -> A:
  (a, r) = p
  a

def sndOf(-A: Data, p: A & String) -> String:
  (a, r) = p
  r

# The composite key "ka(a):kb(b)".
def join(~A: Data, ~B: Data, ~ka: A -> String, ~kb: B -> String, p: Prd<A, B>) -> String:
  match p:
    case P{a, b}:
      ka(a) ++ (":" ++ kb(b))

# A composite key is injective when the head key parses back through take
# (so it holds no ':') and the tail key is injective.
law join_injective:
  for ~A: Data
  for ~B: Data
  for ~ka: A -> String
  for ~kb: B -> String
  for ~pa: @+s: String -> A
  for ~take_key: @x: A -> @r: String -> {take(~A, ~pa, ka(x) ++ (":" ++ r)) == (x, r) : A & String}
  for ~injB: @x: B -> @y: B -> @e: {kb(x) == kb(y) : String} -> {x == y : B}
  for +p: Prd<A, B>
  for +q: Prd<A, B>
  for e: {join(~A, ~B, ~ka, ~kb, p) == join(~A, ~B, ~ka, ~kb, q) : String}
  {p == q : Prd<A, B>}

def join_injective(A, B, ka, kb, pa, take_key, injB, p, q, e):
  match p q:
    case P{+a, +b} P{+c, +d}:
      t = Equal.cong(String, A & String, s => take(~A, ~pa, s), ka(a) ++ (":" ++ kb(b)), ka(c) ++ (":" ++ kb(d)), e)
      u = Equal.trans(A & String, (a, kb(b)), take(~A, ~pa, ka(a) ++ (":" ++ kb(b))), take(~A, ~pa, ka(c) ++ (":" ++ kb(d))), Equal.sym(A & String, take(~A, ~pa, ka(a) ++ (":" ++ kb(b))), (a, kb(b)), take_key(a, kb(b))), t)
      +v = Equal.trans(A & String, (a, kb(b)), take(~A, ~pa, ka(c) ++ (":" ++ kb(d))), (c, kb(d)), u, take_key(c, kb(d)))
      ea = Equal.cong(A & String, A, x => fstOf(A, x), (a, kb(b)), (c, kb(d)), v)
      eb = injB(b, d, Equal.cong(A & String, String, x => sndOf(A, x), (a, kb(b)), (c, kb(d)), v))
      %ea : {P{a, b} == P{_, d} : Prd<A, B>}
      %eb : {P{a, b} == P{a, _} : Prd<A, B>}
      {==}

def prdFst(-A: Data, -B: Data, p: Prd<A, B>) -> A:
  match p:
    case P{a, _}:
      a

def prdSnd(-A: Data, -B: Data, p: Prd<A, B>) -> B:
  match p:
    case P{_, b}:
      b

# Every element of xs is absent from ys.
def Disj(-A: Data, xs: List<&2, A>, +ys: List<&2, A>) -> Type:
  match xs:
    case Nil{}:
      Unit
    case +h <> t:
      NotIn(A, h, ys) & Disj(A, t, ys)

law notIn_append:
  for -A: Data
  for +x: A
  for xs: List<&2, A>
  for +ys: List<&2, A>
  for hx: NotIn(A, x, xs)
  for hy: NotIn(A, x, ys)
  NotIn(A, x, List.append(&2, A, xs, ys))

def notIn_append(A, x, xs, ys, hx, hy):
  match xs:
    case Nil{}:
      hy
    case +h <> +t:
      (ne, rest) = hx
      (ne, notIn_append(A, x, t, ys, rest, hy))

law nodup_append:
  for -A: Data
  for xs: List<&2, A>
  for +ys: List<&2, A>
  for hx: Nodup(A, xs)
  for hy: Nodup(A, ys)
  for d: Disj(A, xs, ys)
  Nodup(A, List.append(&2, A, xs, ys))

def nodup_append(A, xs, ys, hx, hy, d):
  match xs:
    case Nil{}:
      hy
    case +h <> +t:
      (ni, nd) = hx
      (nh, dt) = d
      (notIn_append(A, h, t, ys, ni, nh), nodup_append(A, t, ys, nd, hy, dt))

# ---- Linear distinctness: strictly ascending numeric codes ----

def ltN(a: Nat, b: Nat) -> Bool:
  match a b:
    case 0n 0n:
      False{}
    case 0n 1n+q:
      True{}
    case 1n+p 0n:
      False{}
    case 1n+p 1n+q:
      ltN(p, q)

def isZero(n: Nat) -> Type:
  match n:
    case 0n:
      Unit
    case 1n+p:
      Empty

def predN(n: Nat) -> Nat:
  match n:
    case 0n:
      0n
    case 1n+p:
      p

law ltN_ne:
  for a: Nat
  for b: Nat
  for h: T(ltN(a, b))
  {a != b : Nat}

def ltN_ne(a, b, h):
  match a b:
    case 0n 0n:
      Empty.absurd({0n != 0n : Nat}, h)
    case 0n 1n+q:
      e => (%e : isZero(_); Unit{})
    case 1n+p 0n:
      Empty.absurd({1n+p != 0n : Nat}, h)
    case 1n+p 1n+q:
      e => ltN_ne(p, q, h)(Equal.cong(Nat, Nat, predN, 1n+p, 1n+q, e))

law ltN_trans:
  for a: Nat
  for b: Nat
  for c: Nat
  for h1: T(ltN(a, b))
  for h2: T(ltN(b, c))
  T(ltN(a, c))

def ltN_trans(a, b, c, h1, h2):
  match a b c:
    case 0n 0n _:
      Empty.absurd(T(ltN(0n, c)), h1)
    case 1n+p 0n _:
      Empty.absurd(T(ltN(1n+p, c)), h1)
    case 0n 1n+q 0n:
      Empty.absurd(T(ltN(0n, 0n)), h2)
    case 1n+p 1n+q 0n:
      Empty.absurd(T(ltN(1n+p, 0n)), h2)
    case 0n 1n+q 1n+r:
      Unit{}
    case 1n+p 1n+q 1n+r:
      ltN_trans(p, q, r, h1, h2)

# p < code(first), and codes strictly ascend along xs.
def ascC(~A: Data, ~code: A -> Nat, xs: List<&2, A>, +p: Nat) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case +h <> t:
      Bool.and(ltN(p, code(h)), ascC(~A, ~code, t, code(h)))

def sortedC(~A: Data, ~code: A -> Nat, xs: List<&2, A>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case +h <> t:
      ascC(~A, ~code, t, code(h))

law ascC_below:
  for ~A: Data
  for ~code: A -> Nat
  for xs: List<&2, A>
  for +k: A
  for +p: Nat
  for +hk: T(ltN(code(k), p))
  for +ha: T(ascC(~A, ~code, xs, p))
  NotIn(A, k, xs)

def ascC_below(A, code, xs, k, p, hk, ha):
  match xs:
    case Nil{}:
      Unit{}
    case +h <> +t:
      +lt = ltN_trans(code(k), p, code(h), hk, andL(ltN(p, code(h)), ascC(~A, ~code, t, code(h)), ha))
      (e => ltN_ne(code(k), code(h), lt)(Equal.cong(A, Nat, code, k, h, e)), ascC_below(~A, ~code, t, k, code(h), lt, andR(ltN(p, code(h)), ascC(~A, ~code, t, code(h)), ha)))

law ascC_at:
  for ~A: Data
  for ~code: A -> Nat
  for xs: List<&2, A>
  for +k: A
  for +ha: T(ascC(~A, ~code, xs, code(k)))
  NotIn(A, k, xs)

def ascC_at(A, code, xs, k, ha):
  match xs:
    case Nil{}:
      Unit{}
    case +h <> +t:
      +lt = andL(ltN(code(k), code(h)), ascC(~A, ~code, t, code(h)), ha)
      (e => ltN_ne(code(k), code(h), lt)(Equal.cong(A, Nat, code, k, h, e)), ascC_below(~A, ~code, t, k, code(h), lt, andR(ltN(code(k), code(h)), ascC(~A, ~code, t, code(h)), ha)))

law ascC_sorted:
  for ~A: Data
  for ~code: A -> Nat
  for xs: List<&2, A>
  for +p: Nat
  for +ha: T(ascC(~A, ~code, xs, p))
  T(sortedC(~A, ~code, xs))

def ascC_sorted(A, code, xs, p, ha):
  match xs:
    case Nil{}:
      Unit{}
    case +h <> +t:
      andR(ltN(p, code(h)), ascC(~A, ~code, t, code(h)), ha)

# A sorted code list has no duplicates. Linear, unlike distinctC.
law sortedC_sound:
  for ~A: Data
  for ~code: A -> Nat
  for xs: List<&2, A>
  for +h: T(sortedC(~A, ~code, xs))
  Nodup(A, xs)

def sortedC_sound(A, code, xs, h):
  match xs:
    case Nil{}:
      Unit{}
    case +x <> +t:
      (ascC_at(~A, ~code, t, x, h), sortedC_sound(~A, ~code, t, ascC_sorted(~A, ~code, t, code(x), h)))
