import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);
let typescript;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith("file:") &&
      (specifier.startsWith(".") || specifier.startsWith("file:")) &&
      specifier.endsWith(".js")
    ) {
      const javascriptUrl = new URL(specifier, context.parentURL);
      const typescriptUrl = new URL(javascriptUrl.href.replace(/\.js$/, ".ts"));
      if (!existsSync(fileURLToPath(javascriptUrl)) && existsSync(fileURLToPath(typescriptUrl))) {
        return { shortCircuit: true, url: typescriptUrl.href };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    typescript ??= require("typescript");
    const result = typescript.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: {
        module: typescript.ModuleKind.ESNext,
        target: typescript.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", shortCircuit: true, source: result.outputText };
  },
});
