import { parseServerArgs, resolveRepoRoot, runCommand } from "./core.js";

const cli = parseServerArgs(process.argv.slice(2));
if (cli.help) {
  process.stdout.write("Usage: node src/doctor.js [--repo /absolute/path/to/repository]\n");
  process.exit(0);
}

try {
  const repoRoot = await resolveRepoRoot(cli.repo);
  const git = await runCommand("git", ["--version"], { cwd: repoRoot });
  const ocr = await runCommand("ocr", ["--version"], { cwd: repoRoot });
  const previewHelp = await runCommand("ocr", ["delegate", "preview", "--help"], { cwd: repoRoot });
  const ruleHelp = await runCommand("ocr", ["delegate", "rule", "--help"], { cwd: repoRoot });
  const scanHelp = await runCommand("ocr", ["scan", "--help"], { cwd: repoRoot });
  const rulesCheckHelp = await runCommand("ocr", ["rules", "check", "--help"], { cwd: repoRoot });
  const previewJson = /--format/.test(previewHelp.stdout + previewHelp.stderr);
  const ruleJson = /--format/.test(ruleHelp.stdout + ruleHelp.stderr);
  const scanPreviewSupported = /--preview/.test(scanHelp.stdout + scanHelp.stderr) && /--format/.test(scanHelp.stdout + scanHelp.stderr);
  const rulesCheckSupported = /<file-path>/.test(rulesCheckHelp.stdout + rulesCheckHelp.stderr);
  const report = {
    ok: previewJson && ruleJson && scanPreviewSupported && rulesCheckSupported,
    repo_root: repoRoot,
    git_version: git.stdout.trim(),
    ocr_version: ocr.stdout.trim(),
    delegate_preview_json_supported: previewJson,
    delegate_rule_json_supported: ruleJson,
    scan_preview_json_supported: scanPreviewSupported,
    rules_check_supported: rulesCheckSupported
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
