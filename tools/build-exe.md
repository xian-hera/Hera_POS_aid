# Building hera-giftcard-tool.exe

`tools/giftcard-tool.js` is an interactive menu (make a batch / check a cards.csv). It runs with
`node tools/giftcard-tool.js`, or as a single Windows program built with Node's single-executable support (SEA).
The program is unsigned and its console messages are English only (the Windows console garbles other languages).
Rebuild it whenever `giftcard.js` or `tools/giftcard-tool.js` changes, because both are packed inside.

Needs Node 22 and `esbuild` + `postject` (`npm i -D esbuild postject`). Use the Windows Node of the SAME version as the Node you build with.

```
# 1. one CommonJS file
npx esbuild tools/giftcard-tool.js --bundle --platform=node --format=cjs --target=node22 --outfile=dist/tool.cjs

# 2. the SEA blob
echo { "main": "dist/tool.cjs", "output": "sea.blob", "disableExperimentalSEAWarning": true, "useCodeCache": false, "useSnapshot": false } > sea-config.json
node --experimental-sea-config sea-config.json

# 3. take node.exe (https://nodejs.org/dist/v22.23.4/win-x64/node.exe), copy it to hera-giftcard-tool.exe,
#    remove its code signature (signtool remove /s hera-giftcard-tool.exe), then inject the blob
npx postject hera-giftcard-tool.exe NODE_SEA_BLOB sea.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

The output (`giftcards-output/<time>/cards.csv`) is written next to the .exe. The secret is typed hidden and never stored.
