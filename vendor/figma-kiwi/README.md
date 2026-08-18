# vendored figma-kiwi decode assets

- `figma_decoder.js` — generated Kiwi decoder for Figma's wire protocol
  (schema captured 2026-08-18; MessageType dictionary stable across sessions).
  Requires `kiwi-schema` (below) via `require("kiwi-schema")`.
- `node_modules/kiwi-schema/` — minimal `kiwi-schema` package, built from
  https://github.com/evanw/kiwi (MIT), providing `ByteBuffer` for the decoder.

Provenance: `figma-kiwi-protocol` (https://github.com/allan-simon/figma-kiwi-protocol, MIT)
+ `evanw/kiwi` (MIT). Decoder generated with `kiwi/js/cli.ts --schema schema.bin --js figma_decoder.js`.
