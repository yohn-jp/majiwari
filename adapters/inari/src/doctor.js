import { checkAdapterHealth, parseServerArgs, resolveRepoRoot } from "./core.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write("Usage: node src/doctor.js [--repo /absolute/path/to/repository]\n");
  process.exit(0);
}

try {
  const repoRoot = await resolveRepoRoot(cli.repo);
  const report = await checkAdapterHealth(repoRoot);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
