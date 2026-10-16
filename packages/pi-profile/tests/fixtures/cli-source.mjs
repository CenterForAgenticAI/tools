// Run the CLI from src/ (Node strips the types), whatever is in dist/.
const mod = await import(new URL("../../src/cli/main.ts", import.meta.url).href);
process.exitCode = mod.main(process.argv.slice(2), mod.processIo());
