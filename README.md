# chainrom

A program stored inside a chain, and run from it.

Live ROM: [`0xaaa063ded7115b3346b140bf1a1f9c46074a6591`](https://rpc.mainnet.chain.robinhood.com)
on Robinhood Chain (id 4663).

Every byte of the engine and its data is deployed as **contract code**. This page
reads it out of chain state, rebuilds a keccak256 merkle tree from what actually
arrived, compares the root with the one the contract sealed, inflates it, and
only then compiles the WebAssembly. Nothing is served from this site but the
reader itself.

Because the bytes are contract code rather than transaction data, the ROM
contract can read its own chunks with `EXTCODECOPY` and verify a merkle proof
on chain — `verify(index, proof)` is evaluated by the EVM, not by this page.

`?rom=0x…&rpc=…` points the reader at a different ROM or node. Nothing here is
privileged; the verification does not depend on which endpoint answered.

## Contents

Only the reader is published here. `js/*.mjs` are copied verbatim from the
project's tested sources, so the page runs the code the test suite covers.

`js/vendor/` is [@noble/hashes](https://github.com/paulmillr/noble-hashes) by
Paul Miller, MIT licensed — see `js/vendor/LICENSE-noble-hashes`. The only edits
are relative import paths, because browsers do not resolve bare specifiers.
