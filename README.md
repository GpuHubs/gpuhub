# GPUhub

Idle GPUs, put to work. AI agents rent spare PCs and cloud GPUs by the second. Rent is priced in dollars and paid in the project token (GHUB); 5% of every payment is burned, and there is no treasury.

Website: https://gpuhub.app

This repository holds the parts you may want to read or run yourself.

| Folder | What it is |
| --- | --- |
| `contracts/` | The Solidity contracts. `ComputeMarket.sol` is the market: balances, spend vouchers (EIP-712), settlement, the discount pool and the 5% burn. `UniV3TwapFeed.sol` and `Pons.sol` price the token from a time-weighted average, never a spot price. `UniV3Swap.sol` and the swap in `Pons.sol` turn USDG into the token. |
| `provider/` | The Windows app that rents out a PC through isolated containers (gVisor when available), and the agent that runs inside a rented cloud machine. |
| `extension/` | The browser extension (Chrome and Edge, Manifest V3) that rents out a browser for WASM and WebGPU work. |

## Build

Contracts use Solidity 0.8.28 and OpenZeppelin Contracts.

```
cd extension && npm install && npm run build   # writes extension/dist, load it unpacked in chrome://extensions
cd provider  && npm install && npm start       # PAYOUT=0x... HOURLY_USD=0.10 COORDINATOR=https://gpuhub.app
```

## Safety notes

- A renter's code never touches the owner's files or network: containers have no network, no mounts and are limited in CPU, memory and processes.
- The payout address needs no private key on the machine.
- Please report security problems privately through GitHub's "Report a vulnerability" button on this repository.

## License

MIT
