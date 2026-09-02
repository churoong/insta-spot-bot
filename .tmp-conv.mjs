import { Font } from "fonteditor-core";
import fs from "node:fs";
import * as pako from "pako";
for (const [w, out] of [["assets/fonts/GmarketSansBold.woff", "assets/fonts/GmarketSansBold.ttf"],
                        ["assets/fonts/GmarketSansMedium.woff", "assets/fonts/GmarketSansMedium.ttf"]]) {
  const buf = fs.readFileSync(w);
  const font = Font.create(buf, { type: "woff", inflate: (d) => pako.inflate(new Uint8Array(d)) });
  fs.writeFileSync(out, Buffer.from(font.write({ type: "ttf" })));
  console.log(out, fs.statSync(out).size);
}
