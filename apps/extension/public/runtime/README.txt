BrowserCortex production builds require this reviewed executable runtime asset:

SmolLM2-360M-Instruct-q4f16_1_cs1k-webgpu.wasm
SHA-256: 5c20098605780550c40e9c64d288dd6e369707a08d4133037156019b064ad41b
SRI: sha256-XCAJhgV4BVDEDpxk0ojdbjaXB6CNQTMDcVYBmwZK1Bs=

The release build must fail if the pinned file is absent or its integrity does not match.
Do not replace it with a remote model-library URL.

Chrome 116 is the API floor for the selected side-panel surface. Chrome 153 is the
current acceptance target and must receive the production CSP and runtime smoke test.
