import { readFile, writeFile } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
const [, , input, output] = process.argv;
const css = await readFile(input, "utf8");
const result = await postcss([tailwind()]).process(css, { from: input, to: output });
await writeFile(output, result.css);
console.log("css bytes:", result.css.length);
