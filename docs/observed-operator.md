# A working operator, read off the chain

Notes from inspecting a live TRON payment operator, recorded because they
settle several design questions that were otherwise guesswork. Everything here
comes from public chain data, queried directly rather than read off a block
explorer.

- User wallet: `TEequgePqnQsfsEWpPwUvg2SU7r3tyb22p`
- Main wallet: `TMzxCvdt9rhdPvBNCVunD5VbafgSV7PkQG`

## The shape

One permanent wallet per end user. A deposit lands, and the full amount is
forwarded to a single main wallet a couple of minutes later.

```
16:59:06  in   151.73 USDT   from the payer
17:01:06  out  151.73 USDT   to the main wallet
```

Seven sweeps sampled, all the same: the exact amount received, forwarded
whole, between two and four minutes later. No fee is taken at this step — the
merchant's share is evidently settled in their own books, not on chain.

## A sweep costs no TRX at all

The receipt of a real sweep:

```
fee                    0.000000 TRX
energy used            64,285
  of it burned as TRX  0
bandwidth              345 bytes, within the free daily 600
```

Two things worth noting.

**64,285 energy** is exactly the figure measured independently by simulating a
USDT transfer to an address that already holds USDT. The main wallet is
permanently funded, so every sweep takes the cheap path; a transfer to an
empty address costs 130,285.

**Zero TRX** because the energy was supplied before the transaction ran, and
345 bytes fits inside the 600 every account is given daily. The fee is zero on
the transaction, not zero in total — whatever the energy cost was paid for
somewhere else.

## Nothing is staked on the operating wallets

```
main wallet   TRX staked: 0     energy available: 7,523,271
user wallet   TRX staked: 0     energy available: 0
```

The main wallet's energy is delegated to it from **nine separate accounts** —
rented, or supplied from a staking pool held elsewhere. It delegates to
nobody.

The user wallet shows no delegation at rest, yet its sweeps consumed 64,285
energy each. So energy is supplied to it around the sweep and gone afterwards:
either delegated and reclaimed, or a short rental that expired.

Either way, the operating wallets hold no staked capital.

## What this settles

**Renting beats staking at this scale.** A wallet holding $1.5M in USDT and
processing 3.8M transactions has nothing staked. Whatever the arithmetic says
about a staking pool paying for itself in three years, an operator with real
volume chose not to lock the capital.

**Immediate consolidation beats accumulation.** Every deposit is swept within
minutes rather than left to accumulate. Waiting would save sweeps, but with
energy supplied at near-zero marginal cost there is little to save, and funds
sitting on thousands of user wallets are a risk that consolidation removes.

This contradicts the earlier advice in this repository that accumulation is
the biggest lever. It is the biggest lever *when each sweep burns TRX*. Once
energy is rented, sweeps are cheap enough that the risk argument wins.

**No approvals, no collector contract.** The user wallet has granted zero
allowances. Each sweep is an ordinary transfer signed by the wallet itself,
paid for with supplied energy. The batching contract in `contracts/` is not
what a production operator of this size uses — it saves about 30% on batched
transfers, which matters when sweeps cost something and matters much less when
they cost nothing.

## What it does not tell us

- What the energy actually costs. The rental price is paid off-transaction and
  off-chain; the receipt only shows that the transaction itself was free.
- Whether the nine delegating accounts are rental providers or the operator's
  own staking pool.
- How the merchant's fee is taken, since the full deposit is forwarded.
