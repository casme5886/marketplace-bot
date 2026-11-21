// web/app.html → src/apphtml.ts (Mini App sahifasi bot ichiga joylanadi)
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../web/app.html", import.meta.url), "utf8");
writeFileSync(
  new URL("../src/apphtml.ts", import.meta.url),
  "// ⚠️ Avtomatik yaratilgan: asl nusxa web/app.html (o'zgartirgach: node scripts/build-app.mjs)\nexport default " + JSON.stringify(html) + ";\n",
);
console.log("✅ src/apphtml.ts yangilandi");
