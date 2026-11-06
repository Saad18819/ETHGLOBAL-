# AI use

We built andthen with Claude Code (Anthropic) as a pair programmer. This file lists what it did, so judges can see where AI was involved.

## What we did

- The idea, the product, the sentence UI, the choice of tracks and the architecture (CCTP for money and the intent as hook data, CCIP for the receipt, Uniswap pools as destinations, Bridge Kit for non-USDC assets).
- Every design decision where the docs left a choice, for example emitting our own `Settled` event when Arc's `Memo` contract turned out to reject contract callers.
- Review of all code before it was committed.

## What Claude Code did

- Read the official docs and live chain state before writing integration code: Arc contract addresses and EVM differences, CCTP V2 message format and Iris API, the `@chainlink/contracts-ccip` 2.0.0 sources, the CCIP lane API, Uniswap v4 core and deployments, Circle App Kit, wagmi v3.
- Checked assumptions against testnets with `cast`: which CCIP lanes to Arc exist, which fee tokens and finality modes each lane accepts, that Uniswap v4 is deployed on Arc testnet, and that a USDC/EURC pool exists there.
- Wrote the first drafts of the contracts, tests, deploy scripts and the Next.js app, which we then reviewed and changed.
- Drafted this README.

## Arc Studio

We used Arc Studio, Circle's hosted agent for onchain apps, to audit the contracts. Claude Code sent the sources and a brief through the Arc Studio CLI (`arc-studio run --file ...`); Arc Studio reviewed them in its sandbox and wrote [AUDIT.md](AUDIT.md). The fixes and their regression tests were then made in this repo and are listed at the end of that file.

## Tools

- Claude Code with Claude Opus 5.5
- Arc Studio, for the security review
- Commits written with AI help carry a `Co-Authored-By: Claude` trailer
