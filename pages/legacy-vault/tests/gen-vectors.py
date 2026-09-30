#!/usr/bin/env python3
"""Independent reference implementation of the QTC Legacy Vault share format.

Used ONLY to generate known-answer vectors (tests/vectors/shamir-vectors.json)
that the JavaScript implementation in js/shamir.js must satisfy. It is written
independently of the JS code and follows the format spec documented in
js/shamir.js:

  Share text: LV1-{t}of{n}-#{index}-{hex}
  - GF(2^8) with reducing polynomial x^8+x^4+x^3+x+1 (0x11B)
  - share x-coordinates are the 1-based share indices (1..n)
  - for each secret byte, a random degree-(t-1) polynomial with the secret
    byte as the constant term is evaluated at each x
"""
import json
import random
import sys

IRREDUCIBLE = 0x11B


def gf_mul(a: int, b: int) -> int:
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        hi = a & 0x80
        a = (a << 1) & 0xFF
        if hi:
            a ^= 0x1B
        b >>= 1
    return p


def gf_pow(a: int, e: int) -> int:
    r = 1
    while e:
        if e & 1:
            r = gf_mul(r, a)
        a = gf_mul(a, a)
        e >>= 1
    return r


def gf_inv(a: int) -> int:
    assert a != 0
    return gf_pow(a, 254)


def lagrange_at_zero(xs, ys) -> int:
    """Interpolate at x=0 given points (xs[i], ys[i])."""
    total = 0
    for i in range(len(xs)):
        num, den = 1, 1
        for j in range(len(xs)):
            if i == j:
                continue
            num = gf_mul(num, xs[j])
            den = gf_mul(den, xs[j] ^ xs[i])  # subtraction == XOR in char 2
        total ^= gf_mul(ys[i], gf_mul(num, gf_inv(den)))
    return total


def split(secret: bytes, n: int, t: int, rng: random.Random):
    assert 2 <= t <= n <= 255
    assert len(secret) >= 1
    shares = [bytearray() for _ in range(n)]
    for byte in secret:
        coeff = [byte] + [rng.randrange(256) for _ in range(t - 1)]
        for i in range(n):
            x = i + 1
            y = 0
            # Horner evaluation
            for c in reversed(coeff):
                y = gf_mul(y, x) ^ c
            shares[i].append(y)
    return [
        f"LV1-{t}of{n}-#{i + 1}-{bytes(s).hex()}" for i, s in enumerate(shares)
    ]


def parse_share(text: str):
    parts = text.strip().split("-")
    assert parts[0] == "LV1" and len(parts) == 4, f"bad share: {text[:40]}"
    t_n = parts[1].split("of")
    t, n = int(t_n[0]), int(t_n[1])
    assert parts[2].startswith("#")
    index = int(parts[2][1:])
    payload = bytes.fromhex(parts[3])
    return t, n, index, payload


def combine(share_texts):
    parsed = [parse_share(s) for s in share_texts]
    t = parsed[0][0]
    n = parsed[0][1]
    assert all(p[0] == t and p[1] == n for p in parsed), "mixed t/n"
    assert len({p[2] for p in parsed}) == len(parsed), "duplicate index"
    assert len(parsed) >= t, "not enough shares"
    chosen = parsed[:t]
    length = len(chosen[0][3])
    assert all(len(p[3]) == length for p in chosen), "ragged shares"
    out = bytearray()
    for pos in range(length):
        xs = [p[2] for p in chosen]
        ys = [p[3][pos] for p in chosen]
        out.append(lagrange_at_zero(xs, ys))
    return bytes(out)


def main():
    rng = random.Random(20260930)
    vectors = []
    # random matrix of (secret_len, n, t)
    for v in range(40):
        secret_len = rng.choice([1, 2, 5, 8, 16, 24, 32, 48, 64])
        n = rng.randint(2, 6)
        t = rng.randint(2, n)
        secret = bytes(rng.randrange(256) for _ in range(secret_len))
        shares = split(secret, n, t, rng)
        # self-check: recover from first t shares
        assert combine(shares[:t]) == secret, f"self-check failed on vector {v}"
        # self-check: recover from a different subset of t shares
        subset = rng.sample(shares, t)
        assert combine(subset) == secret, f"subset self-check failed on vector {v}"
        vectors.append(
            {
                "id": v,
                "secret_hex": secret.hex(),
                "n": n,
                "t": t,
                "shares": shares,
            }
        )
    # edge vectors: long secret, max small n, all-zeros, all-0xff, UTF-8 text
    extras = [
        (bytes(rng.randrange(256) for _ in range(300)), 3, 2),
        (b"\x00" * 32, 5, 3),
        (b"\xff" * 32, 5, 5),
        ("Quantus 🕯 legacy — ключи на века".encode("utf-8"), 4, 2),
        (b"a", 2, 2),
    ]
    for k, (secret, n, t) in enumerate(extras):
        shares = split(secret, n, t, rng)
        assert combine(shares[:t]) == secret
        vectors.append(
            {"id": 100 + k, "secret_hex": secret.hex(), "n": n, "t": t, "shares": shares}
        )
    out = {
        "generator": "tests/gen-vectors.py (independent Python reference)",
        "count": len(vectors),
        "vectors": vectors,
    }
    with open("vectors/shamir-vectors.json", "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {len(vectors)} vectors")


if __name__ == "__main__":
    sys.exit(main())
