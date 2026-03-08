import { parseArgs } from "./cli/args";
import { run } from "./cli/run";

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e: unknown) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  switch (args.command) {
    case "run":
      await run(args.scenarioPath, args.target, args.outDir, args.adapter, args.models);
      break;
    case "validate":
      console.error("validate: not yet implemented");
      process.exit(1);
      break;
    case "fanout":
      console.error("fanout: not yet implemented");
      process.exit(1);
      break;
    case "serve":
      console.error("serve: not yet implemented");
      process.exit(1);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
