import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const path = new URL("../dist/src/cli.js", import.meta.url);
const contents = readFileSync(path, "utf8");
if (!contents.startsWith("#!")) writeFileSync(path, "#!/usr/bin/env node\n" + contents, "utf8");
chmodSync(path, 0o755);
