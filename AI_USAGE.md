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

We used Arc Studio, Circle's hosted agent for onchain apps, in three ways. Project: https://studio.arc.io/app/cb20c8eb-57e8-49eb-abda-1c60be57f23f

- **Audit.** Claude Code sent the sources and a brief through the Arc Studio CLI (`arc-studio run --file ...`); Arc Studio reviewed them in its sandbox and wrote [AUDIT.md](AUDIT.md). The fixes and their regression tests were then made in this repo and are listed at the end of that file.
- **Building and deploying the settlement contract.** Studio's workspace could not compile the contracts with their imports, so Claude Code flattened `AndThenSettlement` (`forge flatten`) and placed it in the Studio workspace with `arc-studio run -f studio/AndThenSettlement.flat.sol:contracts/AndThenSettlement.sol --prompt-file studio/deploy-prompt.txt`. Arc Studio compiled it with viaIR and deployed it on Arc Testnet with our constructor arguments and our wallet as owner. Claude Code then checked the deployment on-chain (runtime size and every constructor value) before we ran the owner setup. We did this for both versions of the contract.
- **The EURC hook test receiver.** `HookReceiver` was written and deployed in Studio's chat.

## Tools

- Claude Code with Claude Opus 5.5
- Arc Studio, for the security review and for compiling and deploying the Arc contracts
- Commits written with AI help carry a `Co-Authored-By: Claude` trailer
